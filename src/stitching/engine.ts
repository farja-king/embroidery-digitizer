import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { bridgeRowGaps, centroid, flattenPath, guidedFillRows, normalAt, offsetPolygon, pathLength, perimeterBridge, resamplePath, rotatePoint, straightBridge, tatamiRows } from './geometry';
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
 * Pass 1's 'auto' mode uses the object's own auto heuristic; pass 2 has no such
 * heuristic (a second pass is always an opt-in extra), so its 'auto' just means "none". */
function resolveUnderlay(
  obj: EmbObject,
  field: TwoPassUnderlay | UnderlaySettings | undefined,
  generate: (settings: UnderlaySettings, type: UnderlayType) => Point[],
): Point[] {
  const { pass1, pass2 } = normalizeUnderlay(field);
  const type1 = pass1.mode === 'auto' ? autoUnderlayType(obj) : pass1.type;
  const type2 = pass2.mode === 'auto' ? 'none' : pass2.type;
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

function satinStitches(
  points: Point[],
  width: number,
  density: number,
  underlayPts: Point[],
  pullCompensation: number,
): StitchPoint[] {
  const sampled = resamplePath(points, Math.max(0.2, density));
  const out: StitchPoint[] = [];
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  // Thread tension pulls stitched fabric in toward the column's centerline, so a
  // column sewn at its exact digitized width comes out narrower on fabric than on
  // screen. Push each rail outward by the compensation amount to counteract it.
  const half = width / 2 + Math.max(0, pullCompensation);
  for (let i = 0; i < sampled.length; i++) {
    const n = normalAt(sampled, i);
    const side = i % 2 === 0 ? 1 : -1;
    out.push({
      x: sampled[i].x + n.x * half * side,
      y: sampled[i].y + n.y * half * side,
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
  endPoint: Point | null,
  bridgeMode: 'perimeter' | 'straight',
  guideLine: Point[] | null,
): StitchPoint[] {
  if (polygon.length < 3) return [];
  const bridge = bridgeMode === 'straight'
    ? (_shape: Point[], from: Point, to: Point, step: number) => straightBridge(from, to, step)
    : perimeterBridge;
  const out: StitchPoint[] = [];
  // Dense fill stitching pulls the fabric in toward the shape's center, so the top
  // layer is generated slightly past the digitized outline to come out true-to-size
  // on fabric — the underlay above deliberately stays on the original boundary
  // (actually inset from it), so it can never poke out past this expanded edge.
  const expanded = offsetPolygon(polygon, Math.max(0, pullCompensation));
  const step = Math.max(0.4, stitchLength);
  let rows: Point[];
  if (guideLine && guideLine.length >= 2) {
    // A hand-drawn guide overrides the fixed angle entirely -- rows become
    // shifted copies of the guide's own curve, so direction bends with it
    // instead of staying fixed. Still free to walk from either end, same as
    // a plain angle scan, so start/end alignment works the same way.
    rows = guidedFillRows(expanded, guideLine, rowSpacing, stitchLength);
    reverseTowardTarget(rows, startPoint, endPoint);
  } else if (startPoint && endPoint) {
    // Both ends pinned down: split the fill into two regions meeting at the end
    // point's row instead of one continuous scan bridged across an unrelated
    // gap -- see splitFillRows for the technique.
    rows = splitFillRows(expanded, angle, rowSpacing, stitchLength, startPoint, endPoint, step);
  } else {
    rows = tatamiRows(expanded, angle, rowSpacing, stitchLength);
    // Only a start or only an end pinned -- both-pinned uses splitFillRows
    // above instead, which already handles alignment on both ends itself.
    reverseTowardTarget(rows, startPoint, endPoint);
  }
  // A scan row on a concave shape (an L, a letter, a star's notch) can have more
  // than one disconnected span -- left alone, the row list jumps straight from
  // the end of one span to the start of the next, a stray stitch cutting across
  // whatever open space sits between them. Route any such gap along the shape's
  // own boundary instead, same reasoning as every other bridge in this function.
  const maxRowGap = Math.max(stitchLength, rowSpacing) * 3;
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
  const lastRowPoint = rows[rows.length - 1];
  if (endPoint && lastRowPoint && (Math.abs(lastRowPoint.x - endPoint.x) > 0.05 || Math.abs(lastRowPoint.y - endPoint.y) > 0.05)) {
    for (const p of bridge(expanded, lastRowPoint, endPoint, step)) {
      out.push({ x: p.x, y: p.y, command: 'STITCH' });
    }
  }
  return out;
}

export function generateObjectStitches(obj: EmbObject): StitchPoint[] {
  if (!obj.visible || obj.points.length < 2) return [];
  const flat = flattenPath(obj.points, obj.kind === 'fill');
  switch (obj.kind) {
    case 'running':
      return runningStitches(flat, obj.running.stitchLength, obj.running.triple);
    case 'satin': {
      const underlayPts = resolveUnderlay(obj, obj.satin.underlay, (settings, type) =>
        satinUnderlay(flat, obj.satin.width, settings, type),
      );
      return satinStitches(flat, obj.satin.width, obj.satin.density, underlayPts, obj.satin.pullCompensation ?? 0);
    }
    case 'fill': {
      const underlayPts = resolveUnderlay(obj, obj.fill.underlay, (settings, type) =>
        fillUnderlay(flat, obj.fill.angle, settings, type, obj.fill.startPoint ?? null),
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
  const perObjectStitches = new Map<string, StitchPoint[]>();
  for (const obj of visible) perObjectStitches.set(obj.id, generateObjectStitches(obj));

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
      if (started && jumpDist >= trimThresholdMm) stitches.push({ x: cursor.x, y: cursor.y, command: 'TRIM' });
      const hops = splitLongJump(cursor, first);
      for (const hop of hops) stitches.push({ x: hop.x, y: hop.y, command: 'JUMP' });
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

const TIE_LENGTH_MM = 0.3;

/** A tiny forward-then-back movement at `anchor`, aimed toward `toward`. Two extra
 * needle penetrations almost on top of each other lock the thread end without any
 * visible movement — the standard tie-in/tie-off technique every digitizer uses so
 * a trim doesn't let a thread end work loose. */
function tieStitchesAt(anchor: Point, toward: Point): StitchPoint[] {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return [
    { x: anchor.x + ux * TIE_LENGTH_MM, y: anchor.y + uy * TIE_LENGTH_MM, command: 'STITCH' },
    { x: anchor.x, y: anchor.y, command: 'STITCH' },
  ];
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
      const next = stitches.slice(i + 1).find((x) => x.command === 'STITCH') ?? s;
      out.push(...tieStitchesAt(s, next));
    }
    out.push(s);
    const nextCmd = nextMeaningfulCommand(stitches, i);
    const isRunEnd = nextCmd === 'COLOR_CHANGE' || nextCmd === 'TRIM' || nextCmd === 'END';
    if (isRunEnd) {
      let prevStitch: StitchPoint = s;
      for (let j = out.length - 2; j >= 0; j--) {
        if (out[j].command === 'STITCH') {
          prevStitch = out[j];
          break;
        }
      }
      out.push(...tieStitchesAt(s, prevStitch));
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
