import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { bridgeRowGaps, centroid, flattenPath, guidedFillRows, isConvexPolygon, normalAt, offsetPolygon, offsetPolygonAlong, pathLength, perimeterBridge, regionChainRows, resamplePath, rotatePoint, straightBridge, tatamiRows } from './geometry';
import { autoUnderlayType, fillUnderlay, normalizeUnderlay, satinUnderlay } from './underlay';

/** Covers the whole `[shapeMinY, shapeMaxY]` range as two interleaved passes at
 * double the normal row spacing instead of one: an "out" pass starting right at
 * `anchorY`'s own side and walking to the far extreme, and a "back" pass using
 * the rows in between (offset by one normal spacing) walking from the far
 * extreme back to finish near `anchorY` again. Together both passes still cover
 * the shape at the normal row pitch, but -- unlike a single full-shape scan --
 * both legs start and end on the same (anchor) side, which is what makes this
 * the right technique when start and end points are too close together for a
 * real near/far split (see splitFillRows). `tatamiRows`' own scan order is
 * always low-Y-to-high-Y regardless of anchor -- ascending order only starts
 * *at* the anchor side when the anchor itself sits at the low extreme, so
 * whichever pass needs to start at a high-side anchor gets reversed instead
 * (and the other pass, needing to start at the opposite/far extreme, reversed
 * the other way around). Tries every left/right start parity for both legs and
 * keeps whichever pairing gives the shortest actual join between them, same
 * reasoning as splitFillRows itself. */
function thereAndBackRows(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  shapeMinY: number,
  shapeMaxY: number,
  anchorY: number,
  step: number,
): Point[] {
  const doubleSpacing = rowSpacing * 2;
  const fullRange: [number, number] = [shapeMinY, shapeMaxY];
  // Anchor nearer the max extreme: "out" must start high (reverse the natural
  // ascending scan) and "back" must start low, finishing high (no reverse).
  // Anchor nearer the min extreme: the opposite -- "out" needs no reverse,
  // "back" does.
  const anchorNearMax = Math.abs(anchorY - shapeMaxY) < Math.abs(anchorY - shapeMinY);
  let best: { out: Point[]; back: Point[]; cost: number } | null = null;
  for (const outLtr of [true, false]) {
    for (const backLtr of [true, false]) {
      let out = tatamiRows(polygon, angle, doubleSpacing, stitchLength, fullRange, anchorY, outLtr);
      if (anchorNearMax) out = out.reverse();
      let back = tatamiRows(polygon, angle, doubleSpacing, stitchLength, fullRange, anchorY + rowSpacing, backLtr);
      if (!anchorNearMax) back = back.reverse();
      if (out.length === 0 || back.length === 0) continue;
      const cost = pathLength(perimeterBridge(polygon, out[out.length - 1], back[0], step));
      if (!best || cost < best.cost) best = { out, back, cost };
    }
  }
  if (!best) {
    // Nothing fit even at double spacing (a genuinely tiny shape) -- a plain
    // single-spacing scan is the only thing left to fall back to.
    return tatamiRows(polygon, angle, rowSpacing, stitchLength, fullRange, anchorY);
  }
  const travel =
    Math.abs(best.out[best.out.length - 1].x - best.back[0].x) > 0.05 ||
    Math.abs(best.out[best.out.length - 1].y - best.back[0].y) > 0.05
      ? perimeterBridge(polygon, best.out[best.out.length - 1], best.back[0], step)
      : [];
  return [...best.out, ...travel, ...best.back];
}

/** When both a start and end point are set, splits the fill into two independently
 * -scanned regions meeting at the row level of the end point, instead of one
 * continuous scan bridged across a possibly-unrelated gap. This is how real
 * digitizing software handles an end point that isn't at either natural scan
 * extreme: stitch from the start point up to the end point's row (the "near"
 * region), travel around the shape's own edge to the far extreme, then stitch
 * back down from there to the end point's row (the "far" region) -- the two
 * regions' fill meets cleanly at the shared row instead of leaving a gap or a
 * stray line cutting across already-stitched fill.
 *
 * The inter-region travel always walks the shape's own perimeter (never a
 * straight line) because by the time it happens the near region is already
 * fully stitched -- a straight bridge there would necessarily cut back across
 * that finished fill, which this technique exists specifically to avoid.
 * Which side of the shape each region's boundary-adjacent row starts/ends on
 * is otherwise just whatever an arbitrary row count happens to produce --
 * left uncontrolled, that can put the near region's last stitch and the far
 * region's first stitch on opposite sides of the shape, forcing the travel
 * the long way around even when both points are actually near the same
 * side. Both regions' row-start parity is tried in every combination and
 * whichever pairing gives the shortest actual perimeter travel is kept. */
function splitFillRows(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  startPoint: Point,
  endPoint: Point,
  step: number,
): Point[] {
  const c = centroid(polygon);
  const rotated = polygon.map((p) => rotatePoint(p, c, -angle));
  const ys = rotated.map((p) => p.y);
  const shapeMinY = Math.min(...ys);
  const shapeMaxY = Math.max(...ys);
  const splitY = Math.min(shapeMaxY, Math.max(shapeMinY, rotatePoint(endPoint, c, -angle).y));
  const startLocalY = rotatePoint(startPoint, c, -angle).y;
  // Whichever shape extreme the start point sits closer to is the "near" side --
  // the region that gets stitched first, straight from the start point.
  const nearIsMin = Math.abs(startLocalY - shapeMinY) <= Math.abs(startLocalY - shapeMaxY);
  // Both calls share splitY as their row-grid anchor so the row nearest the
  // boundary on each side lands exactly rowSpacing/2 from it -- without this,
  // each region anchors independently to its own edge and can leave up to a
  // full rowSpacing gap (double the normal row pitch) uncovered right at the
  // seam, which shows up as a visible gap line where the two regions meet.
  const nearRange: [number, number] = nearIsMin ? [shapeMinY, splitY] : [splitY, shapeMaxY];
  const farRange: [number, number] = nearIsMin ? [splitY, shapeMaxY] : [shapeMinY, splitY];
  // Near region's ascending order already runs start-side-first only when its
  // range starts at the shape's own min extreme; otherwise it needs reversing
  // so it still starts at the extreme (near the start point). Far region is
  // the mirror image: its ascending order starts at the split (the wrong end)
  // ONLY when near sits on the min side (so far's own range runs [split, max]
  // -- ascending starts at split) -- when near sits on the max side instead,
  // far's range is [min, split], whose ascending order already starts at the
  // far (min) extreme and needs no reversing. Reversing unconditionally here
  // (as this used to) is correct for exactly one of the two cases and
  // silently produces the *opposite* of the intended "far extreme first, ends
  // at split" order in the other -- which reads as one continuous scan
  // straight through the split with no seam, since a wrongly-ordered far
  // region still happens to start right where near left off. That's exactly
  // the "doesn't split, walks straight through to the far end" symptom.
  const nearNeedsReverse = !nearIsMin;
  const farNeedsReverse = nearIsMin;

  // Degenerate case: start and end are actually close together (in the fill
  // angle's own Y axis, not just wherever splitY happens to land) -- there's no
  // real near/far split possible when both ends are on the same side, since
  // whichever "near" sliver that leaves is too thin for even a single row.
  // Falling through to the old single-full-scan fallback below (return farRows
  // when nearRows is empty) is fine when splitY only *coincidentally* lands at
  // a shape extreme (endpoint sitting exactly at the natural scan boundary,
  // with the start point elsewhere -- that full scan already starts close to
  // the start point in that case); it's specifically when the start point
  // itself is also right there that a single full scan instead starts at the
  // *opposite* extreme and needs one long bridge back to actually reach the
  // end point -- the "goes all the way from the bottom to the top and never
  // really stops at the marker" symptom this was reported as. Use a genuine
  // there-and-back double pass instead for that specific case: every other row
  // going out from the start/end side to the far extreme, then the interleaved
  // remaining rows coming back -- together still covering the whole shape at
  // the normal row pitch, but both legs actually begin and end on the
  // start/end side instead of stranding the finish at the opposite extreme.
  const nearExtreme = nearIsMin ? shapeMinY : shapeMaxY;
  const nearSpan = Math.abs(splitY - nearExtreme);
  // Requiring the start point itself to be genuinely near that same extreme
  // (not just "closer than the other side" by a hair, which a point sitting
  // exactly at the shape's midline can still technically be) rules out a
  // near-miss tie-break coincidentally producing a thin nearRange while the
  // start point actually sits well away from the split -- that case already
  // gets a short entry bridge from the plain single-scan fallback below, so
  // forcing it through the double-pass technique here would be pure downside.
  const startNearExtreme = Math.abs(startLocalY - nearExtreme) < (shapeMaxY - shapeMinY) * 0.35;
  if (nearSpan < rowSpacing && startNearExtreme) {
    return thereAndBackRows(polygon, angle, rowSpacing, stitchLength, shapeMinY, shapeMaxY, splitY, step);
  }

  let best: { near: Point[]; far: Point[]; cost: number } | null = null;
  for (const nearLtr of [true, false]) {
    for (const farLtr of [true, false]) {
      let near = tatamiRows(polygon, angle, rowSpacing, stitchLength, nearRange, splitY, nearLtr);
      if (nearNeedsReverse) near = near.reverse();
      let far = tatamiRows(polygon, angle, rowSpacing, stitchLength, farRange, splitY, farLtr);
      if (farNeedsReverse) far = far.reverse();
      // An empty side here just means the split landed right at a shape extreme
      // (the end point sits exactly at the far/near natural edge) -- a perfectly
      // normal single-region scan, not the degenerate case handled above. No
      // join cost applies since there's nothing on that side to bridge to.
      const cost = near.length && far.length ? pathLength(perimeterBridge(polygon, near[near.length - 1], far[0], step)) : 0;
      if (!best || cost < best.cost) best = { near, far, cost };
    }
  }
  const nearRows = best!.near;
  const farRows = best!.far;

  if (nearRows.length === 0) return farRows;
  if (farRows.length === 0) return nearRows;
  const nearLast = nearRows[nearRows.length - 1];
  const farFirst = farRows[0];
  const travel =
    Math.abs(nearLast.x - farFirst.x) > 0.05 || Math.abs(nearLast.y - farFirst.y) > 0.05
      ? perimeterBridge(polygon, nearLast, farFirst, step)
      : [];
  return [...nearRows, ...travel, ...farRows];
}

/** Runs both underlay passes and concatenates their stitches, pass 1 then pass 2.
 * Both passes resolve 'auto' through the same heuristic (see autoUnderlayType),
 * which knows which pass it is answering for -- on a fill that means edge-run
 * first and tatami second, the standard pairing. */
function resolveUnderlay(
  obj: EmbObject,
  field: TwoPassUnderlay | UnderlaySettings | undefined,
  generate: (settings: UnderlaySettings, type: UnderlayType) => Point[],
): Point[] {
  const { pass1, pass2 } = normalizeUnderlay(field);
  const type1 = pass1.mode === 'auto' ? autoUnderlayType(obj, 1) : pass1.type;
  const type2 = pass2.mode === 'auto' ? autoUnderlayType(obj, 2) : pass2.type;
  return [...generate(pass1, type1), ...generate(pass2, type2)];
}

export type Command = 'STITCH' | 'JUMP' | 'TRIM' | 'COLOR_CHANGE' | 'END';

export interface StitchPoint {
  x: number; // mm, design space
  y: number; // mm, design space
  command: Command;
}

function runningStitches(points: Point[], stitchLength: number, triple: boolean): StitchPoint[] {
  const sampled = resamplePath(points, Math.max(0.2, stitchLength));
  const out: StitchPoint[] = [];
  for (let i = 0; i < sampled.length; i++) {
    const reps = triple && i > 0 ? 3 : 1;
    for (let r = 0; r < reps; r++) out.push({ x: sampled[i].x, y: sampled[i].y, command: 'STITCH' });
  }
  return out;
}

/** Half-width at a given arc-length position along a centreline, interpolated
 * from a per-point table. The satin resamples the centreline much more finely
 * than the table was built at, so the two cannot be indexed together; arc
 * length is the common measure. */
function halfWidthSampler(points: Point[], halfWidths: number[]): (t: number) => number {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return (t: number) => {
    if (halfWidths.length === 0) return 0;
    if (t <= 0) return halfWidths[0];
    const last = cum[cum.length - 1];
    if (t >= last) return halfWidths[Math.min(halfWidths.length - 1, points.length - 1)];
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    const f = (t - cum[lo]) / span;
    const a = halfWidths[Math.min(lo, halfWidths.length - 1)];
    const b = halfWidths[Math.min(hi, halfWidths.length - 1)];
    return a + (b - a) * f;
  };
}

function satinStitches(
  points: Point[],
  width: number,
  density: number,
  underlayPts: Point[],
  pullCompensation: number,
  railLeft?: number[],
  railRight?: number[],
): StitchPoint[] {
  // `density` is the gap between two needle penetrations on the SAME rail --
  // the measure every digitizer and Hatch itself uses, and the number stamped on
  // the properties panel. A satin alternates rails on every stitch, so the
  // centerline has to be sampled at half that gap to produce it. Sampling the
  // centerline at `density` directly (which this used to do) laid down same-rail
  // stitches twice as far apart as the setting claimed: 0.4 gave 0.8mm, so a
  // column set to a normal density came out at half the thread it should have.
  // Measured against Hatch's own text export, which lands on 0.400mm same-rail
  // at its 0.4 setting.
  let sampled = resamplePath(points, Math.max(0.05, density / 2));
  const out: StitchPoint[] = [];
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });

  // The underlay ends wherever it ends -- a centre-run finishes at the far end
  // of the column. Starting the top stitching back at the centreline's first
  // point then throws one stitch the whole length of the column to get there,
  // straight back over the underlay. On a 7mm stem that is a 7mm stitch, on
  // every column in a word. Run the column from whichever end the thread is
  // already at instead; a satin column covers the same ground either way.
  if (underlayPts.length > 0 && sampled.length > 1) {
    const at = underlayPts[underlayPts.length - 1];
    const toStart = Math.hypot(at.x - sampled[0].x, at.y - sampled[0].y);
    const toEnd = Math.hypot(at.x - sampled[sampled.length - 1].x, at.y - sampled[sampled.length - 1].y);
    if (toEnd < toStart) sampled = [...sampled].reverse();
  }

  // Thread tension pulls stitched fabric in toward the column's centerline, so a
  // column sewn at its exact digitized width comes out narrower on fabric than on
  // screen. Push each rail outward by the compensation amount to counteract it.
  //
  // Capped as a share of the column's own width. Compensation is a fixed number
  // of millimetres, which is right for the hand-drawn columns it was set for but
  // ruinous on a narrow one: 0.35mm a side on a 0.92mm letter stroke is a column
  // 76% wider than the letter, so the strokes bloat, overlap each other at
  // junctions and spill outside the letterform. A quarter of the width per side
  // is as far as compensation can sensibly go.
  const comp = Math.min(Math.max(0, pullCompensation), width * 0.25);

  // Where the shape's own half-width is known point by point, the rails follow
  // it. A letter stroke tapers and is cut flat at its ends, and a constant-width
  // band drawn down its middle spills outside the letterform at every terminal.
  const usable = (v?: number[]) => v && v.length === points.length && points.length > 1;
  const leftAt = usable(railLeft) ? halfWidthSampler(points, railLeft!) : null;
  const rightAt = usable(railRight) ? halfWidthSampler(points, railRight!) : null;
  const reversed = leftAt !== null && sampled[0] !== points[0];
  let travelled = 0;
  const totalLen = (() => {
    let t = 0;
    for (let i = 1; i < points.length; i++) t += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return t;
  })();

  for (let i = 0; i < sampled.length; i++) {
    if (i > 0) travelled += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
    const n = normalAt(sampled, i);
    const side = i % 2 === 0 ? 1 : -1;
    // Reversing the column swaps which side of travel each rail is on, so the
    // two tables swap with it.
    const t = reversed ? totalLen - travelled : travelled;
    const positive = leftAt && rightAt ? (reversed ? rightAt(t) : leftAt(t)) : width / 2;
    const negative = leftAt && rightAt ? (reversed ? leftAt(t) : rightAt(t)) : width / 2;
    const reach = (side === 1 ? positive : negative) + comp;
    out.push({
      x: sampled[i].x + n.x * reach * side,
      y: sampled[i].y + n.y * reach * side,
      command: 'STITCH',
    });
  }
  return out;
}

// Reverses `rows` in place when that lands its natural finish closer to
// whichever of startPoint/endPoint is set (end prioritized when both are --
// see fillStitches for why). A boustrophedon-style scan's whole point
// sequence can always be walked from either end (each row's own internal
// zigzag direction flips too, staying consistent), so this is a free choice
// of which end is "first" -- shared by the plain angle scan and the guided
// scan, which both produce exactly this kind of reversible row list.
function reverseTowardTarget(rows: Point[], startPoint: Point | null, endPoint: Point | null): void {
  if (rows.length <= 1 || (!startPoint && !endPoint)) return;
  const target = (endPoint ?? startPoint)!;
  const distFirst = Math.hypot(rows[0].x - target.x, rows[0].y - target.y);
  const distLast = Math.hypot(rows[rows.length - 1].x - target.x, rows[rows.length - 1].y - target.y);
  const shouldReverse = !!endPoint ? distFirst < distLast : distLast < distFirst;
  if (shouldReverse) rows.reverse();
}

function fillStitches(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  underlayPts: Point[],
  pullCompensation: number,
  startPoint: Point | null,
  entryHint: Point | null,
  exitHint: Point | null,
  endPoint: Point | null,
  bridgeMode: 'perimeter' | 'straight',
  guideLine: Point[] | null,
): StitchPoint[] {
  if (polygon.length < 3) return [];
  const bridge = bridgeMode === 'straight'
    ? (_shape: Point[], from: Point, to: Point, step: number) => straightBridge(from, to, step)
    : perimeterBridge;
  const out: StitchPoint[] = [];
  // Dense fill stitching draws the fabric in along the line of the stitches — a
  // row of tatami pulls its own two ends toward each other — so the top layer is
  // generated with every row lengthened at both ends to come out true-to-size on
  // fabric. Only along the rows: nothing spans across them to pull that way, and
  // growing the outline uniformly (what this used to do) overshoots across the
  // grain where there was no pull to correct. The underlay deliberately stays on
  // the original boundary (actually inset from it), so it can never poke out past
  // this edge. A guided fill's rows follow the guide's own bend rather than one
  // fixed angle, so there is no single direction to extend along — it keeps the
  // uniform offset.
  // Where the thread is coming from, for deciding which end to start at. A
  // start marker the user dragged onto the shape says it outright; otherwise
  // the previous object's finishing point stands in. The difference matters:
  // a marker is a place to stitch from, and is on the shape. A hint is only a
  // direction to prefer -- it can be anywhere, including well outside, so it
  // must never be stitched to.
  const anchor = startPoint ?? entryHint;

  // And where it should try to finish. A scanline fill's two ends are opposite
  // corners of the row block, so choosing where to start already decides where
  // it ends -- picking the nearest start can still leave the finish on the far
  // side from whatever comes next. Pinning both ends is what splitFillRows is
  // for, and it only ever ran when the user had dragged both markers on. Given
  // somewhere the thread needs to get to next, the point on this shape nearest
  // to it serves as the end to aim at. Only an end marker the user actually set
  // is stitched to; this one only steers the scan.
  const exitAnchor = endPoint ?? (exitHint ? nearestPointOn(polygon, exitHint) : null);

  const comp = Math.max(0, pullCompensation);
  const expanded = guideLine && guideLine.length >= 2
    ? offsetPolygon(polygon, comp)
    : offsetPolygonAlong(polygon, comp, angle);
  const step = Math.max(0.4, stitchLength);
  let rows: Point[];
  if (guideLine && guideLine.length >= 2) {
    // A hand-drawn guide overrides the fixed angle entirely -- rows become
    // shifted copies of the guide's own curve, so direction bends with it
    // instead of staying fixed. Still free to walk from either end, same as
    // a plain angle scan, so start/end alignment works the same way.
    rows = guidedFillRows(expanded, guideLine, rowSpacing, stitchLength);
    reverseTowardTarget(rows, anchor, endPoint);
  } else if (!isConvexPolygon(polygon)) {
    // A non-convex outline: no single fixed scan direction can cross it
    // cleanly (see connectedRegionRows/regionChainRows), so neither
    // splitFillRows' Y-range partition nor a plain single scan is the right
    // technique here -- stitch each connected region as its own block,
    // anchored starting as close to the start point as possible. The final
    // endpoint bridge below still reaches the actual end point regardless of
    // where the chain naturally finishes.
    rows = regionChainRows(expanded, angle, rowSpacing, stitchLength, anchor, step, exitAnchor);
  } else if (anchor && exitAnchor) {
    // Both ends pinned down, convex outline: split the fill into two regions
    // meeting at the end point's row instead of one continuous scan bridged
    // across an unrelated gap -- see splitFillRows for the technique.
    rows = splitFillRows(expanded, angle, rowSpacing, stitchLength, anchor, exitAnchor, step);
  } else if (anchor || exitAnchor) {
    // Only somewhere to start from. Reversing the row list alone picks which
    // end of the shape the scan begins at, but not which side of the row -- so
    // the first stitch could still land a whole width away from the thread.
    // Both are free choices that cover the shape identically, so try each and
    // begin wherever is actually nearest.
    // Both are free choices that cover the shape identically, so score all four
    // on the travel they actually cost: how far the thread has to come to start,
    // plus how far it will have to go afterwards to reach whatever is stitched
    // next. Judging only the entry leaves the scan finishing on the far side of
    // the shape from the next element, which is where the long jumps came from.
    let best: Point[] | null = null;
    let bestCost = Infinity;
    for (const leftToRight of [true, false]) {
      for (const reversed of [false, true]) {
        const candidate = tatamiRows(expanded, angle, rowSpacing, stitchLength, undefined, undefined, leftToRight);
        if (candidate.length === 0) continue;
        const ordered = reversed ? [...candidate].reverse() : candidate;
        const last = ordered[ordered.length - 1];
        const cost =
          (anchor ? Math.hypot(ordered[0].x - anchor.x, ordered[0].y - anchor.y) : 0) +
          (exitAnchor ? Math.hypot(last.x - exitAnchor.x, last.y - exitAnchor.y) : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = ordered;
        }
      }
    }
    rows = best ?? tatamiRows(expanded, angle, rowSpacing, stitchLength);
  } else {
    rows = tatamiRows(expanded, angle, rowSpacing, stitchLength);
    reverseTowardTarget(rows, anchor, exitAnchor);
  }
  // A scan row on a concave shape (an L, a letter, a star's notch) can have more
  // than one disconnected span -- left alone, the row list jumps straight from
  // the end of one span to the start of the next, a stray stitch cutting across
  // whatever open space sits between them. Route any such gap along the shape's
  // own boundary instead, same reasoning as every other bridge in this function.
  // The threshold is deliberately close to the fill's own stitch length: anything
  // longer than about a stitch and a half isn't a row-to-row step any more, it's
  // travel, and travel belongs on the boundary rather than cutting across open
  // space. A real Hatch file (measured from a user-supplied DST) never exceeds
  // roughly its own stitch length anywhere -- every move, including travel
  // between parts of a shape, is an ordinary walking stitch along the edge --
  // so a generous multiple here just leaves visible strays behind.
  const maxRowGap = Math.max(stitchLength, rowSpacing) * 1.5;
  rows = bridgeRowGaps(rows, expanded, maxRowGap, step);
  // Entry: from the chosen start point (if any) to wherever generation actually
  // begins -- the underlay's own first stitch when there's underlay, otherwise
  // the top-layer scan's first row point directly. Not every underlay type
  // aligns its own first stitch to the entry point the way edge-run/center-run
  // do (plain 'tatami' rows scan from the shape's own minY regardless of where
  // the user put the start marker), so this bridge is needed even when
  // underlay is present, not only when it isn't.
  const genesis = underlayPts.length ? underlayPts[0] : rows[0];
  if (startPoint) {
    out.push({ x: startPoint.x, y: startPoint.y, command: 'STITCH' });
    if (genesis && (Math.abs(genesis.x - startPoint.x) > 0.05 || Math.abs(genesis.y - startPoint.y) > 0.05)) {
      for (const p of bridge(polygon, startPoint, genesis, step)) out.push({ x: p.x, y: p.y, command: 'STITCH' });
    }
  }
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  // The underlay is a there-and-back trip: it starts at the entry point, delivers
  // out to the far side, and returns -- so it always ends back at (or very near)
  // the start point. The top layer picks up from exactly there and scans across,
  // finishing near the end point (already chosen above by picking whichever scan
  // direction lands its natural finish closest to the target). What's bridged
  // here is only the handoff in between: wherever the underlay actually left off
  // to wherever the top-layer scan actually begins. Only relevant when there's
  // underlay -- with none, the entry bridge above already reaches rows[0] directly.
  if (underlayPts.length) {
    const entry = underlayPts[underlayPts.length - 1];
    const topFirst = rows[0];
    if (topFirst && (Math.abs(entry.x - topFirst.x) > 0.05 || Math.abs(entry.y - topFirst.y) > 0.05)) {
      for (const p of bridge(polygon, entry, topFirst, step)) {
        out.push({ x: p.x, y: p.y, command: 'STITCH' });
      }
    }
  }
  for (const p of rows) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  // The scan naturally finishes wherever the last row happens to end -- if the user
  // dragged the end marker somewhere else (to line up with the next same-color
  // shape's start, say), bridge there along the shape's own edge instead of leaving
  // it wherever the scan stopped, so buildPattern's jump from here is short and
  // deliberate rather than a straight line back across the shape's interior.
  // A perimeter bridge is the right answer when the scan genuinely ends somewhere
  // else in the shape, but it is the wrong answer for the last millimetre. The
  // routing above already aims the final row at the marker, so what is usually
  // left is a fraction of a row's width -- and if that tiny gap straddles a
  // concave vertex (the tip of a notch, say), walking the outline "the shorter
  // way" round can still mean most of the perimeter to close a sub-millimetre
  // gap. That is precisely the long walk back to the end point this whole
  // routing exists to avoid, reintroduced at the very last stitch. Anything
  // within a row's reach is closed by stitching straight to the marker instead:
  // it is shorter than a single ordinary stitch and lands under the fill.
  const lastRowPoint = rows[rows.length - 1];
  if (endPoint && lastRowPoint && (Math.abs(lastRowPoint.x - endPoint.x) > 0.05 || Math.abs(lastRowPoint.y - endPoint.y) > 0.05)) {
    const gap = Math.hypot(lastRowPoint.x - endPoint.x, lastRowPoint.y - endPoint.y);
    const direct = gap <= Math.max(rowSpacing * 2, stitchLength);
    const path = direct ? [endPoint] : bridge(expanded, lastRowPoint, endPoint, step);
    for (const p of path) {
      out.push({ x: p.x, y: p.y, command: 'STITCH' });
    }
  }
  // Nothing a fill emits -- rows, entry, the underlay handoff, travel bridges --
  // should ever be longer than the stitch length the object is set to. The
  // format-level guard (clampLongStitches, at 12.1mm) only exists to keep a file
  // writable; it is not a quality bar. Measured against a real Hatch file, every
  // single stitch including travel stays at or under its own stitch length, and
  // a lone oversized stitch left in the middle of an otherwise even run is
  // exactly the kind of thing that reads as sloppy on fabric.
  const maxFillStitch = Math.max(0.5, stitchLength);
  const evened: StitchPoint[] = [];
  for (const sp of out) {
    const prev = evened.length ? evened[evened.length - 1] : null;
    if (prev) {
      const d = Math.hypot(sp.x - prev.x, sp.y - prev.y);
      if (d > maxFillStitch) {
        const steps = Math.ceil(d / maxFillStitch);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          evened.push({ x: prev.x + (sp.x - prev.x) * t, y: prev.y + (sp.y - prev.y) * t, command: 'STITCH' });
        }
      }
    }
    evened.push(sp);
  }
  return evened;
}

/** Splits a multi-column satin object's `points` into its columns. */
/** A satin column given as its two edges: the needle crosses from one to the
 * other and back, advancing by the density each time. This is how a digitized
 * font defines a column, and it is exact -- no centreline is guessed at, and
 * the stitch angle is whatever the two rails imply, including the deliberate
 * slant a digitizer puts on a curve. */
function railStitches(
  a: Point[],
  b: Point[],
  density: number,
  pullCompensation: number,
  exitTowards?: Point | null,
  entryFrom?: Point | null,
): StitchPoint[] {
  let n = Math.min(a.length, b.length);
  if (n < 2) return [];
  // Which rail the first penetration goes to is as free as which it ends on.
  // Starting on the side the thread is already at saves a stroke width of
  // travel across bare fabric at every join.
  if (entryFrom) {
    const da = Math.hypot(a[0].x - entryFrom.x, a[0].y - entryFrom.y);
    const db = Math.hypot(b[0].x - entryFrom.x, b[0].y - entryFrom.y);
    if (db < da) {
      const t = a;
      a = b;
      b = t;
    }
  }
  n = Math.min(a.length, b.length);
  // The two rails come paired: a[i] and b[i] are the ends of one rung, so the
  // distance between them is the width of the stroke at that point. Walking a
  // fraction along each rail independently to find facing points instead would
  // lose that -- on a curve the outer rail runs ahead of the inner one, and the
  // column pinches and swells as the mismatch drifts.
  const step = (r: Point[], i: number) => Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.max(step(a, i), step(b, i)));
  const total = cum[n - 1];
  if (total < 1e-6) return [];
  // Half the density, because the needle lands on one rail per step and it is
  // the spacing down a single rail that the density setting names.
  let steps = Math.max(2, Math.round(total / Math.max(0.025, density / 2)) + 1);
  // Which rail the last penetration lands on is set by whether the step count
  // is odd or even, and one step either way changes the spacing by a fraction
  // of a per cent on anything but the shortest stroke. So it is free to choose,
  // and worth choosing: finishing on the side facing wherever the thread goes
  // next takes a stroke width off the travel, every time.
  if (exitTowards) {
    const far = steps % 2 === 1 ? a : b;
    const near = steps % 2 === 1 ? b : a;
    const end = far[far.length - 1];
    const alt = near[near.length - 1];
    const dEnd = Math.hypot(end.x - exitTowards.x, end.y - exitTowards.y);
    const dAlt = Math.hypot(alt.x - exitTowards.x, alt.y - exitTowards.y);
    if (dAlt < dEnd) steps += 1;
  }
  const comp = Math.max(0, pullCompensation);
  // How close two holes on one edge may come before the inner one is shortened.
  const minGap = Math.max(0.15, density * 0.5);
  const out: StitchPoint[] = [];
  let lastA: Point | null = null;
  let lastB: Point | null = null;
  let j = 1;
  for (let k = 0; k < steps; k++) {
    const t = (total * k) / (steps - 1);
    while (j < n - 1 && cum[j] < t) j++;
    const span = cum[j] - cum[j - 1] || 1;
    const u = Math.min(1, Math.max(0, (t - cum[j - 1]) / span));
    let ax = a[j - 1].x + (a[j].x - a[j - 1].x) * u;
    let ay = a[j - 1].y + (a[j].y - a[j - 1].y) * u;
    let bx = b[j - 1].x + (b[j].x - b[j - 1].x) * u;
    let by = b[j - 1].y + (b[j].y - b[j - 1].y) * u;
    if (comp > 0) {
      // Compensation pushes each rail a little further out along the line
      // between them, which is the direction the fabric pulls in.
      const dx = bx - ax, dy = by - ay;
      const d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        const ux = dx / d, uy = dy / d;
        ax -= ux * comp; ay -= uy * comp;
        bx += ux * comp; by += uy * comp;
      }
    }
    // One penetration per step, alternating rails, so every stitch crosses the
    // column. Landing on both rails at each step would put the same needle
    // points down but join them in the order across, a hair along the rail,
    // back across -- and that hair is a 0.35mm stitch on every other
    // penetration. Machines break thread on stitches that short or drop them,
    // and half of ours were under 0.6mm against Hatch's 0.6 per cent.
    const onA = k % 2 === 0;
    let px = onA ? ax : bx;
    let py = onA ? ay : by;
    const qx = onA ? bx : ax;
    const qy = onA ? by : ay;
    const last = onA ? lastA : lastB;

    // Short stitches, on the inside of a curve.
    //
    // The spacing is set from the longer edge, so the outer edge of a curve is
    // covered without gaps. The inner edge then has less distance to cover in
    // the same number of steps, and its holes crowd: round the bowl of an "e"
    // they closed to 0.09mm, a quarter of the 0.36mm asked for, which is a row
    // of perforations rather than a line of stitching. So where a hole would
    // land too close to the one before it on that edge, it is pulled back
    // along the stitch towards the far edge until it is clear -- at most half
    // way, which is as short as a stitch can be without leaving the edge bare.
    // The thread still crosses, the coverage is unchanged, and the fabric is
    // not cut. The two ends are left alone: those corners are where the next
    // stroke is measured from.
    if (last && k > 0 && k < steps - 1) {
      const d0 = Math.hypot(px - last.x, py - last.y);
      if (d0 < minGap) {
        let lo = 0;
        let hi = 0.5;
        for (let it = 0; it < 12; it++) {
          const m = (lo + hi) / 2;
          const cx = px + (qx - px) * m;
          const cy = py + (qy - py) * m;
          if (Math.hypot(cx - last.x, cy - last.y) < minGap) lo = m;
          else hi = m;
        }
        px += (qx - px) * hi;
        py += (qy - py) * hi;
      }
    }
    const pen = { x: px, y: py };
    if (onA) lastA = pen;
    else lastB = pen;
    out.push({ x: px, y: py, command: 'STITCH' });
  }
  return out;
}

function columnsOf(obj: EmbObject): { points: Point[]; width: number; railLeft?: number[]; railRight?: number[] }[] {
  const breaks = obj.satin.columnBreaks ?? [];
  const bounds = [0, ...breaks.filter((b) => b > 0 && b < obj.points.length), obj.points.length];
  const cols: { points: Point[]; width: number; railLeft?: number[]; railRight?: number[] }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const slice = obj.points.slice(bounds[i], bounds[i + 1]);
    if (slice.length < 2) continue;
    cols.push({
      points: slice.map((p) => ({ x: p.x, y: p.y })),
      width: obj.satin.columnWidths?.[cols.length] ?? obj.satin.width,
      railLeft: obj.satin.pointRailLeft?.slice(bounds[i], bounds[i + 1]),
      railRight: obj.satin.pointRailRight?.slice(bounds[i], bounds[i + 1]),
    });
  }
  return cols;
}

/** A letter: several satin columns stitched in sequence, joined by travel
 * stitches rather than trims.
 *
 * The columns are visited nearest-first, each free to be stitched from either
 * end, so the thread never crosses the letter to reach the next stroke. Between
 * two columns it runs a plain line at the object's own stitch length -- short,
 * and buried under the stroke it lands on. That is what a digitized font does:
 * one letter, one run of thread, no trim until the letter is finished. */
function letterStitches(obj: EmbObject, exit?: Point | null): StitchPoint[] {
  // A letter from a digitized font carries both rails of every column, so it
  // is stitched from those directly rather than from a centreline and a width.
  const splits = obj.satin.railSplits;
  if (splits && splits.length > 0) return railLetterStitches(obj, splits, exit);

  const cols = columnsOf(obj);
  if (cols.length === 0) return [];

  const remaining = cols.map((c, i) => ({ ...c, i }));
  const out: StitchPoint[] = [];
  let cursor: Point | null = null;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestRev = false;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const pts = remaining[i].points;
      const head = pts[0];
      const tail = pts[pts.length - 1];
      const dHead = cursor ? Math.hypot(head.x - cursor.x, head.y - cursor.y) : 0;
      const dTail = cursor ? Math.hypot(tail.x - cursor.x, tail.y - cursor.y) : 0;
      if (dHead < bestDist) {
        bestDist = dHead;
        bestIdx = i;
        bestRev = false;
      }
      if (dTail < bestDist) {
        bestDist = dTail;
        bestIdx = i;
        bestRev = true;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    const line = bestRev ? [...chosen.points].reverse() : chosen.points;

    // Walk to this column's start, at the object's own stitch length so the
    // travel is never one long stride.
    if (cursor && bestDist > 0.05) {
      const step = Math.max(0.5, obj.running.stitchLength);
      for (const p of resamplePath([cursor, line[0]], step).slice(1)) {
        out.push({ x: p.x, y: p.y, command: 'STITCH' });
      }
    }

    const underlayPts = resolveUnderlay(obj, obj.satin.underlay, (settings, type) =>
      satinUnderlay(line, chosen.width, settings, type),
    );
    const rl = chosen.railLeft && bestRev ? [...chosen.railLeft].reverse() : chosen.railLeft;
    const rr = chosen.railRight && bestRev ? [...chosen.railRight].reverse() : chosen.railRight;
    const colStitches = satinStitches(line, chosen.width, obj.satin.density, underlayPts, obj.satin.pullCompensation ?? 0, rl, rr);
    out.push(...colStitches);
    const last = colStitches[colStitches.length - 1];
    if (last) cursor = { x: last.x, y: last.y };
  }
  return out;
}

/** Stitches a letter whose columns are stored as pairs of rails, in the order
 * the font gives them -- which is the order the original was sewn in -- walking
 * between columns rather than trimming, so the letter is one run of thread. */
/** Travel from one stroke of a letter to the next without leaving the letter.
 *
 * A straight line between two strokes cuts across whatever is between them --
 * on a letter that means over the counter of an "e" or out through the side of
 * a "T", where the thread is lying on bare fabric with nothing over it. A
 * stroke that has just been sewn is a covered path, so the way across is to
 * walk back along it to the point nearest where the thread has to be, and only
 * then step off. The step is short and lands under the next stroke.
 *
 * `centre` is the centreline of the stroke just finished; `from` is where the
 * needle is; `to` is where the next stroke starts. */
function routeVia(centre: Point[], from: Point, to: Point): Point[] {
  if (centre.length < 2) return [from, to];
  const nearest = (p: Point): number => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < centre.length; i++) {
      const d = Math.hypot(centre[i].x - p.x, centre[i].y - p.y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };
  const start = nearest(from);
  const finish = nearest(to);
  const along: Point[] = [];
  const dir = finish >= start ? 1 : -1;
  for (let i = start; dir > 0 ? i <= finish : i >= finish; i += dir) along.push(centre[i]);

  // Only worth it if it is actually shorter than going straight -- on two
  // strokes that already touch, the direct hop is both shorter and inside.
  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  let viaLen = 0;
  const via = [from, ...along, to];
  for (let i = 1; i < via.length; i++) viaLen += Math.hypot(via[i].x - via[i - 1].x, via[i].y - via[i - 1].y);
  return viaLen <= direct * 1.6 ? via : [from, to];
}

function walkWithinLetter(centre: Point[], from: Point, to: Point, step: number): Point[] {
  if (centre.length < 2) return resamplePath([from, to], step).slice(1);
  return resamplePath(routeVia(centre, from, to), step).slice(1);
}

/** Whether this stroke's underlay finishes at the far end.
 *
 * A pass that runs the length of the stroke once -- a centre run, a single
 * zigzag -- leaves the needle down there, and the top stitching then comes
 * back over it, so the stroke ends where the thread arrived. A pass that goes
 * out and back leaves it at the near end and the top stitching runs away. The
 * answer does not depend on which way round the stroke is sewn, so it can be
 * settled once from the stored geometry, before any routing. */
function underlayEndsFar(obj: EmbObject, a: Point[], b: Point[]): boolean {
  const centre = a.map((p, i) => {
    const q = b[Math.min(i, b.length - 1)];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  });
  const width = Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y);
  const pts = resolveUnderlay(obj, obj.satin.underlay, (settings, type) =>
    satinUnderlay(centre, width, settings, type),
  );
  const at = pts[pts.length - 1];
  if (!at) return false;
  const head = centre[0];
  const tail = centre[centre.length - 1];
  return Math.hypot(at.x - tail.x, at.y - tail.y) < Math.hypot(at.x - head.x, at.y - head.y);
}

function railLetterStitches(obj: EmbObject, splits: number[], exit?: Point | null): StitchPoint[] {
  const breaks = obj.satin.columnBreaks ?? [];
  const bounds = [0, ...breaks.filter((b) => b > 0 && b < obj.points.length), obj.points.length];

  // Pull the columns out first, each as its two rails, and work out for each
  // whether its underlay will turn the top stitching round. Which end a stroke
  // finishes at is what the router is choosing between, so it has to be known
  // before the route is picked rather than discovered while sewing it.
  const columns: LetterColumn[] = [];
  for (let c = 0; c + 1 < bounds.length; c++) {
    const from = bounds[c];
    const to = bounds[c + 1];
    const split = from + (splits[c] ?? Math.floor((to - from) / 2));
    const a = obj.points.slice(from, split).map((p) => ({ x: p.x, y: p.y }));
    const b = obj.points.slice(split, to).map((p) => ({ x: p.x, y: p.y }));
    if (a.length < 2 || b.length < 2) continue;
    columns.push({ a, b, returnsToStart: underlayEndsFar(obj, a, b) });
  }
  if (columns.length === 0) return [];

  // Letters are stitched in reading order, but the strokes inside a letter are
  // taken nearest-first. Which stroke to sew next is a free choice -- they all
  // have to be sewn -- so taking the nearest one, entered at whichever of its
  // two ends is closer, is always at least as short as the order they happen to
  // be stored in. Left in stored order the thread crossed back over finished
  // letters to reach the next stroke.
  const letterStarts = (obj.satin.letterBreaks ?? [0]).filter((i) => i >= 0 && i < columns.length);
  const groups: { a: Point[]; b: Point[] }[][] = [];
  const starts = letterStarts.length > 0 ? letterStarts : [0];
  for (let g = 0; g < starts.length; g++) {
    groups.push(columns.slice(starts[g], starts[g + 1] ?? columns.length));
  }

  const out: StitchPoint[] = [];
  let cursor: Point | null = null;
  // The centreline of the stroke just finished, which is a covered path the
  // thread can travel back along to reach the next one.
  let lastCentre: Point[] | null = null;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    // Where the thread has to be by the end of this letter: the start of the
    // next one. Without that the letter finishes on whichever stroke greedy
    // ordering happened to leave until last, which can be the far side, and
    // the walk to the next letter then crosses back over the whole letter.
    // The last letter of a word aims at whatever the pattern goes on to sew,
    // so a word ends nearest the next object rather than wherever its final
    // stroke happened to fall.
    const nextGroup = groups[gi + 1];
    const targets = nextGroup ? entryCandidates(nextGroup) : exit ? [exit] : [];
    const order = bestColumnOrder(group, cursor, targets);

    for (let oi = 0; oi < order.length; oi++) {
      const { column, flip } = order[oi];
      // Where the thread has to get to once this stroke is done: the start of
      // the next stroke in the letter, or the nearest way into whatever comes
      // after the letter. The stroke finishes on whichever of its two sides
      // faces that.
      const next = order[oi + 1];
      const aim = next
        ? (next.flip ? next.column.a[next.column.a.length - 1] : next.column.a[0])
        : nearestOf(targets, endsOfColumn(column, flip));
      const ra = flip ? [...column.a].reverse() : column.a;
      const rb = flip ? [...column.b].reverse() : column.b;

      const underlayPts = resolveUnderlay(obj, obj.satin.underlay, (settings, type) => {
        const centre = ra.map((p, i) => {
          const q = rb[Math.min(i, rb.length - 1)];
          return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        });
        const w = Math.hypot(ra[0].x - rb[0].x, ra[0].y - rb[0].y);
        return satinUnderlay(centre, w, settings, type);
      });

      // Walk to wherever the needle actually goes down first: the start of the
      // underlay if there is one, otherwise whichever side of the stroke's near
      // end the thread is closer to. Heading for one nominated edge instead
      // adds a stroke's width of bare thread at a join, and leaves the router
      // costing a walk that is not the one taken.
      const first = underlayPts[0]
        ?? (cursor && Math.hypot(rb[0].x - cursor.x, rb[0].y - cursor.y) < Math.hypot(ra[0].x - cursor.x, ra[0].y - cursor.y)
          ? rb[0]
          : ra[0]);
      if (cursor && Math.hypot(first.x - cursor.x, first.y - cursor.y) > 0.05) {
        const step = Math.max(0.5, obj.running.stitchLength);
        const route = lastCentre
          ? walkWithinLetter(lastCentre, cursor, first, step)
          : resamplePath([cursor, first], step).slice(1);
        for (const p of route) out.push({ x: p.x, y: p.y, command: 'STITCH' });
      }
      out.push(...underlayPts.map((p) => ({ x: p.x, y: p.y, command: 'STITCH' as const })));

      // The underlay runs the length of the column and finishes at the far end,
      // so the top stitching starts from whichever end the thread is now at.
      let sa = ra;
      let sb = rb;
      const at = underlayPts[underlayPts.length - 1];
      if (at) {
        const toHead = Math.hypot(at.x - sa[0].x, at.y - sa[0].y);
        const toTail = Math.hypot(at.x - sa[sa.length - 1].x, at.y - sa[sa.length - 1].y);
        if (toTail < toHead) {
          sa = [...sa].reverse();
          sb = [...sb].reverse();
        }
      }

      const col = railStitches(sa, sb, obj.satin.density, obj.satin.pullCompensation ?? 0, aim, cursor);
      out.push(...col);
      const last = col[col.length - 1];
      if (last) cursor = { x: last.x, y: last.y };
      lastCentre = sa.map((p, i) => {
        const q = sb[Math.min(i, sb.length - 1)];
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      });
    }
  }
  return out;
}

type LetterColumn = {
  a: Point[];
  b: Point[];
  /** Whether the top stitching will finish back at the end it started from.
   *
   * An underlay that runs the length of the stroke once leaves the thread at
   * the far end, so the top stitching comes back over it and the stroke ends
   * where it began. One that goes out and back leaves it at the near end, and
   * the top stitching then runs away from it. Either is fine, but the router
   * has to know which: it is choosing where each stroke finishes so the join
   * to the next one is as short as possible, and if the underlay silently
   * turns the stroke round afterwards every one of those choices is wrong.
   * That is why switching the underlay on used to move all the joins. */
  returnsToStart?: boolean;
};

/** The two corners at the end a stroke will be left from. */
function endsOfColumn(c: LetterColumn, flip: boolean): Point[] {
  const head = [c.a[0], c.b[0]];
  const tail = [c.a[c.a.length - 1], c.b[c.b.length - 1]];
  if (c.returnsToStart) return flip ? tail : head;
  return flip ? head : tail;
}

/** The two corners the needle arrives at. */
function startsOfColumn(c: LetterColumn, flip: boolean): Point[] {
  return flip ? [c.a[c.a.length - 1], c.b[c.b.length - 1]] : [c.a[0], c.b[0]];
}

/** Whichever of `targets` is closest to any of `from`, or null if there are
 * none -- the last stroke of the last word has nowhere in particular to be. */
function nearestOf(targets: Point[], from: Point[]): Point | null {
  let best: Point | null = null;
  let bd = Infinity;
  for (const t of targets) {
    for (const f of from) {
      const d = Math.hypot(t.x - f.x, t.y - f.y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
  }
  return best;
}

/** Every point the next letter could actually be entered at: the two ends of
 * each of its strokes. Aiming at the letter's centre instead is too blunt --
 * on a "T" the top and bottom of the stem are near enough equally far from the
 * middle of an "e", so the scan finishes at the top about as often as the
 * bottom, and the travel thread then has to cross the whole letter to get down
 * to where the "e" begins. Aiming at the real attachment points makes the pair
 * of ends the closest available pair, which is the whole point: that thread
 * lies on top of the fabric and its length is what shows. */
function entryCandidates(group: LetterColumn[]): Point[] {
  const out: Point[] = [];
  for (const c of group) {
    if (c.a.length < 2 || c.b.length < 2) continue;
    out.push(c.a[0], c.a[c.a.length - 1], c.b[0], c.b[c.b.length - 1]);
  }
  return out;
}

/** How much more a millimetre of thread on bare fabric counts than a
 * millimetre that lands on the letter.
 *
 * They are not worth the same. Thread that crosses ground the letter covers is
 * stitched over and never seen; thread that crosses the gap between two
 * strokes, or between two letters, lies on top of the fabric with nothing over
 * it, and is the only travel anyone looks at. Counting plain distance, the
 * router will add a millimetre of exposed thread to save a millimetre of
 * hidden thread, which is the wrong way round: on "Text" that put 19.6mm on
 * bare fabric where a route with more total travel needed 14.0mm. */
const EXPOSED_WEIGHT = 3;

/** A coarse map of the ground a letter's strokes cover.
 *
 * Used to ask, of a proposed hop from one stroke to the next, how much of it
 * would lie on bare fabric. A grid rather than real geometry because the
 * router asks the question a few hundred times per letter and the answer only
 * has to be right to about a quarter of a millimetre. */
function letterMask(group: LetterColumn[], cell = 0.25) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of group) {
    for (const p of [...c.a, ...c.b]) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
  const w = Math.max(1, Math.ceil((x1 - x0) / cell));
  const h = Math.max(1, Math.ceil((y1 - y0) / cell));
  const g = new Uint8Array(w * h);
  const mark = (x: number, y: number) => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((y - y0) / cell);
    if (i >= 0 && i < w && j >= 0 && j < h) g[j * w + i] = 1;
  };
  const paint = (A: Point, B: Point) => {
    const n = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y) / (cell * 0.5)));
    for (let k = 0; k <= n; k++) mark(A.x + ((B.x - A.x) * k) / n, A.y + ((B.y - A.y) * k) / n);
  };
  for (const c of group) {
    const n = Math.min(c.a.length, c.b.length);
    for (let i = 0; i < n; i++) {
      paint(c.a[i], c.b[i]);
      // and half way to the next rung, so successive rungs join up
      if (i + 1 < n) {
        paint(
          { x: (c.a[i].x + c.a[i + 1].x) / 2, y: (c.a[i].y + c.a[i + 1].y) / 2 },
          { x: (c.b[i].x + c.b[i + 1].x) / 2, y: (c.b[i].y + c.b[i + 1].y) / 2 },
        );
      }
    }
  }
  return (p: Point) => {
    const i = Math.floor((p.x - x0) / cell);
    const j = Math.floor((p.y - y0) / cell);
    return i >= 0 && i < w && j >= 0 && j < h && g[j * w + i] === 1;
  };
}

/** What a hop from `p` to `q` really costs: its length, with the part that
 * would lie on bare fabric counted `EXPOSED_WEIGHT` times over. */
function travelCost(covers: (p: Point) => boolean, p: Point, q: Point): number {
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  if (L < 1e-9) return 0;
  const n = Math.min(16, Math.max(2, Math.ceil(L / 0.4)));
  let off = 0;
  for (let k = 0; k <= n; k++) {
    if (!covers({ x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n })) off++;
  }
  const bare = off / (n + 1);
  return L * (1 - bare + EXPOSED_WEIGHT * bare);
}

/** What the whole routed walk costs, priced segment by segment. */
function pathCost(covers: (p: Point) => boolean, path: Point[]): number {
  let t = 0;
  for (let i = 1; i < path.length; i++) t += travelCost(covers, path[i - 1], path[i]);
  return t;
}

/** The line down the middle of a stroke, which is the covered ground the
 * needle can walk back along. */
function centreOf(c: LetterColumn): Point[] {
  const n = Math.min(c.a.length, c.b.length);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) out.push({ x: (c.a[i].x + c.b[i].x) / 2, y: (c.a[i].y + c.b[i].y) / 2 });
  return out;
}

/** Picks the order to sew a letter's strokes in, and which end to enter each
 * from, so the thread travels as little as possible -- and, crucially, so the
 * letter finishes next to whatever comes after it.
 *
 * Plain nearest-first gets the first part right and the last part wrong: the
 * stroke left until last is simply whatever remains, which is often on the far
 * side, and the walk out of the letter then crosses back over it. Running the
 * greedy order from every possible starting stroke and scoring each whole route
 * -- including the walk out at the end -- costs nothing at these sizes (a
 * letter is a handful of strokes) and picks a route that both starts and
 * finishes where it should. */
function bestColumnOrder(
  group: LetterColumn[],
  entry: Point | null,
  exitTargets: Point[],
): { column: LetterColumn; flip: boolean }[] {
  if (group.length === 0) return [];
  // Which end of a stroke the needle works from is a choice, and so is which of
  // the two rails it starts and finishes on -- the side the first and last
  // penetrations land on is the router's to set. So the cost of arriving at a
  // stroke, or leaving it, is the nearer of the two corners there, not the
  // distance to rail A alone.
  const endsOf = endsOfColumn;
  const startsOf = startsOfColumn;
  const covers = letterMask(group);
  const gap = (p: Point | null, c: LetterColumn, flip: boolean) =>
    p === null ? 0 : Math.min(...startsOf(c, flip).map((q) => travelCost(covers, p, q)));
  // Leaving a stroke, the needle can walk back down the middle of the one it
  // has just sewn before striking out, and that part of the walk is covered.
  // The router has to price the walk it will actually take, not the straight
  // line: on the "T" of "Text" the two differ by the whole length of the
  // crossbar.
  const centres = new Map<LetterColumn, Point[]>();
  const centreFor = (c: LetterColumn) => {
    let v = centres.get(c);
    if (!v) {
      v = centreOf(c);
      centres.set(c, v);
    }
    return v;
  };
  const hop = (c: LetterColumn, flip: boolean, d: LetterColumn, dflip: boolean) => {
    let best = Infinity;
    for (const p of endsOf(c, flip)) {
      for (const q of startsOf(d, dflip)) best = Math.min(best, pathCost(covers, routeVia(centreFor(c), p, q)));
    }
    return best;
  };
  // Leaving the letter is priced the same way, and it is the case that matters
  // most. On the "T" of "Text" the crossbar's right end is nearest the "e", so
  // by distance alone that is where the letter should finish -- but the whole
  // run from there to the "e" is out in the open. Finishing at the left end
  // instead is three times as far and almost all of it lies under the crossbar
  // the needle has just sewn, with only the gap between the letters showing.
  // The second is the better stitch-out and it is the one an experienced
  // digitizer picks by eye.
  const leaveToExit = (c: LetterColumn, flip: boolean) => {
    let best = Infinity;
    for (const p of endsOf(c, flip)) {
      for (const t of exitTargets) best = Math.min(best, pathCost(covers, routeVia(centreFor(c), p, t)));
    }
    return best === Infinity ? 0 : best;
  };
  // Distance to the nearest place the next letter can be picked up from.
  const toExit = (p: Point) => {
    let best = Infinity;
    for (const t of exitTargets) best = Math.min(best, Math.hypot(p.x - t.x, p.y - t.y));
    return best === Infinity ? 0 : best;
  };
  // Exact shortest route through the letter, by dynamic programming over
  // subsets: for every set of strokes already sewn, and every stroke and
  // direction that set could have finished on, keep only the cheapest way to
  // have got there. A letter has a handful of strokes, so this is instant, and
  // unlike sewing nearest-first it cannot be led into a corner -- the "x" was
  // being finished at the bottom of a leg when its closest approach to the next
  // letter was at the top, because by then the only stroke left was that one.
  const n = group.length;
  if (n > 12) return greedyColumnOrder(group, entry, toExit);
  const S = 1 << n;
  const INF = Infinity;
  // cost[set][last * 2 + flip]
  const cost: number[][] = Array.from({ length: S }, () => new Array(n * 2).fill(INF));
  const from: number[][] = Array.from({ length: S }, () => new Array(n * 2).fill(-1));
  for (let i = 0; i < n; i++) {
    for (const f of [0, 1]) {
      cost[1 << i][i * 2 + f] = gap(entry, group[i], f === 1);
    }
  }
  for (let set = 1; set < S; set++) {
    for (let last = 0; last < n; last++) {
      if (!(set & (1 << last))) continue;
      for (const lf of [0, 1]) {
        const base = cost[set][last * 2 + lf];
        if (base === INF) continue;
        for (let nxt = 0; nxt < n; nxt++) {
          if (set & (1 << nxt)) continue;
          for (const nf of [0, 1]) {
            const c = base + hop(group[last], lf === 1, group[nxt], nf === 1);
            const ns = set | (1 << nxt);
            if (c < cost[ns][nxt * 2 + nf]) {
              cost[ns][nxt * 2 + nf] = c;
              from[ns][nxt * 2 + nf] = last * 2 + lf;
            }
          }
        }
      }
    }
  }
  const full = S - 1;
  let bestKey = -1;
  let bestCost = INF;
  for (let k = 0; k < n * 2; k++) {
    const c = cost[full][k];
    if (c === INF) continue;
    const total = c + leaveToExit(group[k >> 1], (k & 1) === 1);
    if (total < bestCost) {
      bestCost = total;
      bestKey = k;
    }
  }
  if (bestKey < 0) return greedyColumnOrder(group, entry, toExit);
  const route: { column: LetterColumn; flip: boolean }[] = [];
  let set = full;
  let key = bestKey;
  while (key >= 0) {
    route.push({ column: group[key >> 1], flip: (key & 1) === 1 });
    const prev = from[set][key];
    set &= ~(1 << (key >> 1));
    key = prev;
  }
  route.reverse();
  return route;
}

/** Nearest-first from every possible starting stroke, for a letter with more
 * strokes than the exact search is worth running on. */
function greedyColumnOrder(
  group: LetterColumn[],
  entry: Point | null,
  toExit: (p: Point) => number,
): { column: LetterColumn; flip: boolean }[] {
  // A stroke is entered at one end of rail A -- that is where the first
  // penetration goes -- but it can be left from either rail, since the side the
  // last penetration lands on is the router's to choose. So the cost of leaving
  // is the nearer of the two corners at that end.
  const endsOf = (c: LetterColumn, flip: boolean): Point[] =>
    flip ? [c.a[0], c.b[0]] : [c.a[c.a.length - 1], c.b[c.b.length - 1]];
  const startOf = (c: LetterColumn, flip: boolean) => (flip ? c.a[c.a.length - 1] : c.a[0]);
  const gap = (p: Point | null, q: Point) => (p ? Math.hypot(p.x - q.x, p.y - q.y) : 0);
  const leave = (c: LetterColumn, flip: boolean, q: Point) =>
    Math.min(...endsOf(c, flip).map((p) => Math.hypot(p.x - q.x, p.y - q.y)));
  const leaveToExit = (c: LetterColumn, flip: boolean) =>
    Math.min(...endsOf(c, flip).map((p) => toExit(p)));
  let best: { route: { column: LetterColumn; flip: boolean }[]; cost: number } | null = null;
  for (let first = 0; first < group.length; first++) {
    for (const firstFlip of [false, true]) {
      const remaining = group.map((c, i) => ({ c, i })).filter((e) => e.i !== first);
      const route = [{ column: group[first], flip: firstFlip }];
      let cost = gap(entry, startOf(group[first], firstFlip));
      let hereCol = group[first];
      let hereFlip = firstFlip;
      while (remaining.length > 0) {
        let pick = 0;
        let pickFlip = false;
        let pickCost = Infinity;
        for (let k = 0; k < remaining.length; k++) {
          for (const f of [false, true]) {
            const d = leave(hereCol, hereFlip, startOf(remaining[k].c, f));
            if (d < pickCost) {
              pickCost = d;
              pick = k;
              pickFlip = f;
            }
          }
        }
        const taken = remaining.splice(pick, 1)[0];
        route.push({ column: taken.c, flip: pickFlip });
        cost += pickCost;
        hereCol = taken.c;
        hereFlip = pickFlip;
      }
      cost += leaveToExit(hereCol, hereFlip);
      if (!best || cost < best.cost) best = { route, cost };
    }
  }
  return best!.route;
}

export function generateObjectStitches(obj: EmbObject, entry?: Point | null, exit?: Point | null): StitchPoint[] {
  if (!obj.visible || obj.points.length < 2) return [];
  const flat = flattenPath(obj.points, obj.kind === 'fill');
  switch (obj.kind) {
    case 'running':
      return runningStitches(flat, obj.running.stitchLength, obj.running.triple);
    case 'satin': {
      // A multi-column object (a letter built from its strokes) is stitched
      // column by column, walking from the end of one to the start of the next
      // so the whole letter is one continuous run with no trims inside it.
      const breaks = obj.satin.columnBreaks;
      if ((breaks && breaks.length > 0) || (obj.satin.railSplits && obj.satin.railSplits.length > 0)) {
        return letterStitches(obj, exit);
      }
      const underlayPts = resolveUnderlay(obj, obj.satin.underlay, (settings, type) =>
        satinUnderlay(flat, obj.satin.width, settings, type),
      );
      return satinStitches(
        flat,
        obj.satin.width,
        obj.satin.density,
        underlayPts,
        obj.satin.pullCompensation ?? 0,
        obj.satin.pointRailLeft,
        obj.satin.pointRailRight,
      );
    }
    case 'fill': {
      const underlayPts = resolveUnderlay(obj, obj.fill.underlay, (settings, type) =>
        fillUnderlay(flat, obj.fill.angle, settings, type, obj.fill.startPoint ?? entry ?? null),
      );
      const guideLine = obj.fill.guideLine && obj.fill.guideLine.length >= 2 ? flattenPath(obj.fill.guideLine, false) : null;
      return fillStitches(
        flat,
        obj.fill.angle,
        obj.fill.rowSpacing,
        obj.fill.stitchLength,
        underlayPts,
        obj.fill.pullCompensation ?? 0,
        obj.fill.startPoint ?? null,
        entry ?? null,
        exit ?? null,
        obj.fill.endPoint ?? null,
        obj.fill.bridgeMode ?? 'perimeter',
        guideLine,
      );
    }
    default:
      return [];
  }
}

export interface BuiltPattern {
  stitches: StitchPoint[];
  threads: { r: number; g: number; b: number }[];
}

/** Closest point on a closed outline to `p`. Used to turn "the next element is
 * over there" into a place on this shape to aim the scan at. */
function nearestPointOn(polygon: Point[], p: Point): Point {
  let best = polygon[0];
  let bestD = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

const MAX_STITCH_MM = 12.1; // ~121 units of 0.1mm, the tightest ceiling among the four formats (DST/EXP)

/** Center of the STITCH-only bounding box across all objects, in design-space mm —
 * mirrors toMachinePattern's centering exactly, so the initial jump (below) is
 * measured against the same point that becomes (0,0) in the exported file. */
function contentCenter(perObjectStitches: Map<string, StitchPoint[]>, objects: EmbObject[]): Point | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const obj of objects) {
    for (const s of perObjectStitches.get(obj.id) ?? []) {
      if (s.command !== 'STITCH') continue;
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
  }
  if (minX === Infinity) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function splitLongJump(from: Point, to: Point): Point[] {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d <= MAX_STITCH_MM) return [to];
  const steps = Math.ceil(d / MAX_STITCH_MM);
  const pts: Point[] = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return pts;
}

/** Flattens all visible objects, in list order, into one stitch sequence with
 * JUMP between disconnected objects, TRIM when the jump is long, and COLOR_CHANGE
 * whenever consecutive objects use a different thread color. */
export function buildPattern(objects: EmbObject[], trimThresholdMm = 3): BuiltPattern {
  const visible = objects.filter((o) => o.points.length >= 2 && o.visible);
  // Generated in order, each object told where the thread was left by the one
  // before, so it can start near there rather than wherever its own scan
  // begins. Without that, two shapes a couple of millimetres apart could still
  // be 24mm apart by thread, which the machine reads as a move and cuts.
  const perObjectStitches = new Map<string, StitchPoint[]>();
  let handoff: Point | null = null;
  for (let i = 0; i < visible.length; i++) {
    // Where the next element sits, so this one can finish on the side facing
    // it rather than on the far side. Its centre is enough of a direction --
    // the exact entry point is not known until it is generated, and using its
    // centre avoids that circularity.
    const next = visible[i + 1];
    const exit = next ? centroid(next.points.map((p) => ({ x: p.x, y: p.y }))) : null;
    const st = generateObjectStitches(visible[i], handoff, exit);
    perObjectStitches.set(visible[i].id, st);
    const last = st[st.length - 1];
    if (last) handoff = { x: last.x, y: last.y };
  }

  // toMachinePattern later centers the whole design on its STITCH-only bounding box,
  // which becomes (0,0) in the exported file. The machine "starts" there too, so the
  // very first jump must be measured against that same point — not design-space (0,0),
  // which centering shifts away from (0,0) in the final file.
  let cursor: Point = contentCenter(perObjectStitches, visible) ?? { x: 0, y: 0 };

  const stitches: StitchPoint[] = [];
  const threads: { r: number; g: number; b: number }[] = [];
  let started = false;
  let lastColorKey = '';

  for (const obj of visible) {
    const objStitches = perObjectStitches.get(obj.id)!;
    if (objStitches.length === 0) continue;

    const colorKey = `${obj.color.r},${obj.color.g},${obj.color.b}`;
    if (colorKey !== lastColorKey) {
      threads.push({ ...obj.color });
      if (started) stitches.push({ x: cursor.x, y: cursor.y, command: 'COLOR_CHANGE' });
      lastColorKey = colorKey;
    }

    const first = objStitches[0];
    const jumpDist = Math.hypot(first.x - cursor.x, first.y - cursor.y);
    if (jumpDist > 0.3) {
      // A real machine ties off and cuts the thread at wherever it just finished
      // stitching, *then* travels to the next start — not the other way around.
      // TRIM is therefore a zero-delta "cut here" marker at the *departure* point
      // (cursor, before any movement), and only after that does the JUMP travel to
      // the new position — every format writer below just encodes each command at
      // wherever it sits in this sequence, so this order is what actually ends up
      // in the exported file, not just how the canvas preview draws the scissor.
      // Never trim before the very first stitch of the whole design: nothing has
      // been sewn yet, so there's no trailing thread to cut, just a positioning jump.
      if (started && jumpDist < trimThresholdMm) {
        // Short enough not to warrant a cut, so walk it rather than jump it. A
        // jump leaves a loose float lying across the fabric between the two
        // elements, held only at its ends; a walk is stitched down and is what
        // a digitizer puts between elements that are close together. Anything
        // at or past the trim threshold is a genuine move and still gets cut.
        for (const p of resamplePath([cursor, first], TRAVEL_STITCH_MM).slice(1)) {
          stitches.push({ x: p.x, y: p.y, command: 'STITCH' });
        }
      } else {
        if (started) stitches.push({ x: cursor.x, y: cursor.y, command: 'TRIM' });
        const hops = splitLongJump(cursor, first);
        for (const hop of hops) stitches.push({ x: hop.x, y: hop.y, command: 'JUMP' });
      }
    }

    for (const sp of objStitches) stitches.push(sp);
    cursor = { x: objStitches[objStitches.length - 1].x, y: objStitches[objStitches.length - 1].y };
    started = true;
  }

  // There's always a trim at the very end of the design too -- not just between
  // objects. The inter-object check above only *skips* a trim when the next
  // element is close enough (within trimThresholdMm) that a plain jump serves
  // fine instead; nothing "follows" the last object to earn that exemption, so
  // its thread always gets cut, matching what a real machine does at the end
  // of a run and what the user explicitly confirmed this app should do.
  if (started) {
    stitches.push({ x: cursor.x, y: cursor.y, command: 'TRIM' });
    stitches.push({ x: cursor.x, y: cursor.y, command: 'END' });
  }
  return { stitches: clampLongStitches(addTieStitches(stitches)), threads };
}

// Measured off a real Hatch export (3 C LOGO.DST, 12 thread runs): every lock
// reaches ~1.2mm, with the tie-in ones running a little longer (1.7-1.9mm)
// because they match the length of the first real stitch they lead into.
// Stitch length for a walk between two elements that are close enough not to
// be cut apart. Short enough to hold the thread down, long enough not to pile
// up needle penetrations in one spot.
const TRAVEL_STITCH_MM = 2;

const LOCK_LENGTH_MM = 1.2;

/** The excursion half of a lock stitch: from `anchor`, out to half the lock
 * length, out to the full lock length, back to half — the caller stitches
 * `anchor` itself on either side, giving the full 0 → L/2 → L → L/2 → 0 figure.
 *
 * This is Hatch's own lock, read straight out of its DST rather than guessed at.
 * Decoding a Hatch file's thread runs, every one starts and ends with exactly
 * that four-penetration pattern along the neighbouring stitch's own direction:
 * e.g. a run beginning 0.00, +0.90, +1.90, +0.90, 0.00 before any real
 * stitching, and one ending -0.60, -1.20, -0.60, 0.00 back down the line it
 * arrived on. The halfway penetration is the part that matters — it puts two
 * needle holes at different points along the same short line so the thread has
 * something to bind against.
 *
 * The previous version here was a single 0.3mm out-and-back. At that size both
 * penetrations can land in effectively the same hole, which on a loose knit or
 * fleece is not a lock at all. `toward` comes from lockTarget, which is far
 * enough along the run for the lock to reach its full length even where the run
 * is made of very short stitches; reach is still clamped to it so the lock never
 * overshoots past where the thread actually goes. */
function tieStitchesAt(anchor: Point, toward: Point): StitchPoint[] {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const reach = Math.min(LOCK_LENGTH_MM, len);
  const at = (d: number): StitchPoint => ({ x: anchor.x + ux * d, y: anchor.y + uy * d, command: 'STITCH' });
  return [at(reach / 2), at(reach), at(reach / 2)];
}

/** Where to aim a lock: the first point at least a lock's length along the run
 * from the anchor. Aiming at the immediately adjacent stitch instead would
 * collapse the lock to that stitch's length, and a run can perfectly well open
 * or close with a string of sub-millimetre stitches (a tight curve, a short
 * underlay segment, the evened-out travel at a row end) -- which would quietly
 * shrink the lock back to the barely-there size this replaced. `path` starts at
 * the anchor and runs in the direction the lock should point. */
function lockTarget(path: Point[]): Point {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (acc >= LOCK_LENGTH_MM) return path[i];
  }
  return path[path.length - 1];
}

/** Inserts tie-in stitches right after every point a new thread run starts from
 * (the very first stitch, or the first stitch after a COLOR_CHANGE/TRIM) and
 * tie-off stitches right before every point a thread run ends at (the last stitch,
 * or the last stitch before a COLOR_CHANGE/TRIM/END) — mirrors Hatch's default
 * lock-stitch behavior at every thread start/end. */
// A long jump splits into several JUMP hops (see splitLongJump), and TRIM now
// sits *before* those hops (see buildPattern) rather than always immediately
// adjacent to the stitch on either side — so "was there a trim/color-change
// here" has to look past any number of JUMPs in between, not just the one
// immediately-adjacent command.
function prevMeaningfulCommand(stitches: StitchPoint[], i: number): Command | null {
  for (let j = i - 1; j >= 0; j--) {
    if (stitches[j].command !== 'JUMP') return stitches[j].command;
  }
  return null;
}
function nextMeaningfulCommand(stitches: StitchPoint[], i: number): Command {
  for (let j = i + 1; j < stitches.length; j++) {
    if (stitches[j].command !== 'JUMP') return stitches[j].command;
  }
  return 'END';
}

function addTieStitches(stitches: StitchPoint[]): StitchPoint[] {
  const out: StitchPoint[] = [];
  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i];
    if (s.command !== 'STITCH') {
      out.push(s);
      continue;
    }
    const prevCmd = prevMeaningfulCommand(stitches, i);
    const isRunStart = prevCmd === null || prevCmd === 'COLOR_CHANGE' || prevCmd === 'TRIM';
    if (isRunStart) {
      // The run's own first penetration, then the excursion out and back -- the
      // `out.push(s)` below closes the figure by returning to it, so the needle
      // has been down at the anchor twice with two more holes along the line
      // between before any real stitching begins.
      const ahead: Point[] = [s];
      for (let j = i + 1; j < stitches.length && ahead.length < 64; j++) {
        if (stitches[j].command !== 'STITCH') break;
        ahead.push(stitches[j]);
      }
      out.push(s);
      out.push(...tieStitchesAt(s, lockTarget(ahead)));
    }
    out.push(s);
    const nextCmd = nextMeaningfulCommand(stitches, i);
    const isRunEnd = nextCmd === 'COLOR_CHANGE' || nextCmd === 'TRIM' || nextCmd === 'END';
    if (isRunEnd) {
      const behind: Point[] = [s];
      for (let j = out.length - 2; j >= 0 && behind.length < 64; j--) {
        if (out[j].command !== 'STITCH') break;
        behind.push(out[j]);
      }
      // s has already been pushed above; run back down the line the thread
      // arrived on and return to s, so the run's final needle position is still
      // exactly the end point the routing worked to reach.
      out.push(...tieStitchesAt(s, lockTarget(behind)));
      out.push(s);
    }
  }
  return out;
}

/** Every format here caps a single stitch/jump delta at ~12.1mm. Satin columns with a
 * wide width + sparse density can exceed that, so split any overlong STITCH into
 * evenly-spaced intermediate stitches (keeps the visual path, just denser). */
function clampLongStitches(stitches: StitchPoint[]): StitchPoint[] {
  const out: StitchPoint[] = [];
  let prev: Point | null = null;
  for (const sp of stitches) {
    if (prev && sp.command === 'STITCH') {
      const d = Math.hypot(sp.x - prev.x, sp.y - prev.y);
      if (d > MAX_STITCH_MM) {
        const steps = Math.ceil(d / MAX_STITCH_MM);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          out.push({ x: prev.x + (sp.x - prev.x) * t, y: prev.y + (sp.y - prev.y) * t, command: 'STITCH' });
        }
      }
    }
    out.push(sp);
    if (sp.command === 'STITCH' || sp.command === 'JUMP') prev = { x: sp.x, y: sp.y };
    else prev = null;
  }
  return out;
}
