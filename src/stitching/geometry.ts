import type { PathPoint, Point } from '../types';

/**
 * Turns sparse corner/curve control points into a dense straight-segment polyline,
 * so every downstream consumer (stitch generators, hit-testing, rendering) can keep
 * working with plain polylines. A 'curve' point is smoothed through via a
 * Catmull-Rom-derived cubic Bezier using its neighbors; a 'corner' point pins the
 * adjacent Bezier control handle to itself, producing a straight line into/out of it.
 * Runs of all-corner points are returned as-is (no curve sampling needed).
 */
export function flattenPath(points: PathPoint[], closed: boolean): Point[] {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  if (points.every((p) => p.type !== 'curve')) return points.map((p) => ({ x: p.x, y: p.y }));

  const SAMPLES = 16;
  const segCount = closed ? n : n - 1;
  const out: Point[] = [{ x: points[0].x, y: points[0].y }];

  for (let i = 0; i < segCount; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p0 = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const p3 = closed ? points[(i + 2) % n] : points[Math.min(n - 1, i + 2)];

    if (p1.type !== 'curve' && p2.type !== 'curve') {
      out.push({ x: p2.x, y: p2.y });
      continue;
    }

    const c1 = p1.type === 'curve' ? { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 } : p1;
    const c2 = p2.type === 'curve' ? { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 } : p2;

    for (let s = 1; s <= SAMPLES; s++) {
      out.push(cubicBezierAt(p1, c1, c2, p2, s / SAMPLES));
    }
  }
  return out;
}

function cubicBezierAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Resample an open polyline at fixed arc-length steps. Always includes the first
 * and last point of the original path. Works with any mix of segment lengths —
 * in particular the many short segments a flattened curve is made of, where
 * several segments in a row can be consumed before a single step is used up. */
export function resamplePath(points: Point[], step: number): Point[] {
  if (points.length < 2 || step <= 0) return points.slice();
  const out: Point[] = [points[0]];
  let accumulated = 0; // distance walked since the last emitted point
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    let segPos = 0; // distance consumed so far within this segment
    while (accumulated + (segLen - segPos) >= step) {
      segPos += step - accumulated;
      const t = segPos / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      accumulated = 0;
    }
    accumulated += segLen - segPos;
  }
  const last = points[points.length - 1];
  const prevOut = out[out.length - 1];
  if (!prevOut || dist(prevOut, last) > 1e-6) out.push(last);
  return out;
}

/** Tangent-derived unit normal (perpendicular, pointing to the "left" of travel) at index i. */
export function normalAt(points: Point[], i: number): Point {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

export function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Offsets a closed polygon outward (positive `amount`) or inward (negative) by
 * moving each vertex along the mitered bisector of its two adjacent edge normals,
 * scaled by 1/cos(half the angle between them) so the *edges themselves* end up
 * exactly `amount` away (a plain averaged-and-renormalized bisector, without this
 * scale, undershoots on anything but a straight run — a square corner only moved
 * ~0.71x the requested amount). Capped so a very acute corner doesn't spike out
 * absurdly far, standard practice for polygon offsetting. Not arc-accurate on
 * sharp corners, but adequate at the scale this is actually used for (pull
 * compensation, underlay inset). Direction is resolved against the centroid
 * rather than assumed from winding order, since a polygon drawn by clicking
 * points can wind either way. */
export function offsetPolygon(polygon: Point[], amount: number): Point[] {
  if (Math.abs(amount) < 1e-9 || polygon.length < 3) return polygon;
  const n = polygon.length;
  const c = centroid(polygon);
  const unitNormal = (a: Point, b: Point): Point => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  };
  return polygon.map((p, i) => {
    const prev = polygon[(i - 1 + n) % n];
    const next = polygon[(i + 1) % n];
    const n1 = unitNormal(prev, p);
    const n2 = unitNormal(p, next);
    let bx = n1.x + n2.x;
    let by = n1.y + n2.y;
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen;
    by /= blen;
    const cosHalfAngle = bx * n1.x + by * n1.y; // bisector·n1 = cos(half the angle between n1,n2)
    const miterScale = Math.min(4, 1 / Math.max(0.25, cosHalfAngle));
    let nx = bx * miterScale;
    let ny = by * miterScale;
    const toVertex = { x: p.x - c.x, y: p.y - c.y };
    if (nx * toVertex.x + ny * toVertex.y < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: p.x + nx * amount, y: p.y + ny * amount };
  });
}

/** Nearest point on a closed loop's perimeter to `p`, as an arc-length distance
 * ("t") walked from loop[0], plus the projected point itself. */
function nearestOnLoop(p: Point, loop: Point[]): { t: number; point: Point } {
  let bestT = 0;
  let bestPoint = loop[0];
  let bestDist = Infinity;
  let acc = 0;
  for (let i = 0; i < loop.length - 1; i++) {
    const a = loop[i];
    const b = loop[i + 1];
    const segLen = dist(a, b);
    if (segLen > 0) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (segLen * segLen);
      t = Math.max(0, Math.min(1, t));
      const proj = { x: a.x + dx * t, y: a.y + dy * t };
      const d = dist(p, proj);
      if (d < bestDist) {
        bestDist = d;
        bestT = acc + t * segLen;
        bestPoint = proj;
      }
    }
    acc += segLen;
  }
  return { t: bestT, point: bestPoint };
}

function pointAtT(loop: Point[], t: number): Point {
  let acc = 0;
  for (let i = 0; i < loop.length - 1; i++) {
    const a = loop[i];
    const b = loop[i + 1];
    const segLen = dist(a, b);
    if (t <= acc + segLen || i === loop.length - 2) {
      const localT = segLen > 0 ? (t - acc) / segLen : 0;
      const clamped = Math.max(0, Math.min(1, localT));
      return { x: a.x + (b.x - a.x) * clamped, y: a.y + (b.y - a.y) * clamped };
    }
    acc += segLen;
  }
  return loop[loop.length - 1];
}

/** Walks a closed polygon's own perimeter from wherever `from` lands on it to
 * wherever `to` lands, in whichever direction around the loop is shorter, resampled
 * at `step`. Used to connect a fill's natural scan-finish point to a start/end the
 * user chose that the scan doesn't land on by itself — a short, edge-hugging bridge
 * instead of a straight line cutting across the shape's interior. */
export function perimeterBridge(polygon: Point[], from: Point, to: Point, step: number): Point[] {
  if (polygon.length < 3) return [to];
  const loop = [...polygon, polygon[0]];
  const total = pathLength(loop);
  if (total < 1e-6) return [to];
  const a = nearestOnLoop(from, loop);
  const b = nearestOnLoop(to, loop);
  const forwardLen = ((b.t - a.t) % total + total) % total;
  const backwardLen = total - forwardLen;
  const forward = forwardLen <= backwardLen;
  const span = forward ? forwardLen : backwardLen;
  const steps = Math.max(1, Math.round(span / Math.max(0.2, step)));
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = forward ? (a.t + (span * i) / steps) % total : ((a.t - (span * i) / steps) % total + total) % total;
    out.push(pointAtT(loop, t));
  }
  out.push(to);
  return out;
}

/** A direct line from `from` to `to`, resampled at `step` -- the "straight through
 * the interior" alternative to perimeterBridge's "walk the edge". Shorter, but only
 * looks clean where the fill is dense enough to bury a stitch cutting across it. */
export function straightBridge(from: Point, to: Point, step: number): Point[] {
  return resamplePath([from, to], Math.max(0.2, step)).slice(1);
}

/** Fixes up a scanline row-fill's raw output for concave shapes: a single scan row
 * can have more than one disconnected span (e.g. both arms of an L, or either side
 * of a star's notch), and consecutive spans get concatenated directly with no
 * awareness that the straight line between them cuts outside the polygon, across
 * open space. Any consecutive pair further apart than `maxGap` gets routed along
 * the polygon's own boundary instead (same `perimeterBridge` reasoning used for
 * every other bridge in this fill engine), so what would otherwise be one long
 * stray straight stitch across a notch instead hugs the actual outline. */
export function bridgeRowGaps(points: Point[], polygon: Point[], maxGap: number, step: number): Point[] {
  if (points.length < 2) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > maxGap) {
      out.push(...perimeterBridge(polygon, prev, cur, step));
    } else {
      out.push(cur);
    }
  }
  return out;
}

export function rotatePoint(p: Point, origin: Point, angleDeg: number): Point {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

export function distanceToPolyline(p: Point, points: Point[], closed: boolean): number {
  let min = Infinity;
  const n = points.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    min = Math.min(min, distanceToSegment(p, a, b));
  }
  return min;
}

export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect =
      pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a / 2;
}

/** True when every turn along the polygon's boundary bends the same way (all cross
 * products of consecutive edge vectors share a sign, collinear runs allowed) -- the
 * standard convex-polygon test. Used to gate splitFillRows/thereAndBackRows: their
 * whole technique assumes a Y-range genuinely partitions the shape into two sensible
 * halves, which only holds for a convex outline. A concave shape (two blocks joined
 * by a narrow waist, an L, a star) can have neighboring scan rows with wildly
 * different widths at the same row-index step, which reads as a "near/far region"
 * boundary to the row generator even though it's really just the shape's own waist
 * -- forcing the split technique there produces far more boundary-hugging travel
 * bridges than a plain single scan needs (bridgeRowGaps already handles a concave
 * row's own multiple spans; it's the *forced* near/far partition on top of that
 * which multiplies the travel). */
export function isConvexPolygon(points: Point[]): boolean {
  const n = points.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const c = points[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Scan-line fill of a (possibly concave, non-self-intersecting) polygon.
 * Returns rows of alternating spans: each row is a flat array of x positions
 * (even-odd rule intersections, sorted), in the polygon's *rotated* coordinate space.
 */
export function scanlineSpans(polygon: Point[], rowY: number): number[] {
  const xs: number[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % n];
    if (p1.y === p2.y) continue; // horizontal edge, skip
    const [lo, hi] = p1.y < p2.y ? [p1, p2] : [p2, p1];
    if (rowY < lo.y || rowY >= hi.y) continue;
    const t = (rowY - lo.y) / (hi.y - lo.y);
    xs.push(lo.x + t * (hi.x - lo.x));
  }
  xs.sort((a, b) => a - b);
  return xs;
}

/** Boustrophedon (snake-pattern) scan-line tatami fill of a polygon at a given angle —
 * the shared row-generation core used both for a fill object's top stitching and for
 * a tatami underlay pass underneath it (at a different angle/spacing). `yRange`
 * (in the same rotated local-Y space the scan itself works in, from `localY`)
 * restricts which rows get generated to a band of the shape -- used to split a
 * fill into two independently-scanned regions that meet at a chosen row instead
 * of always covering the whole shape in one continuous pass. `anchorY`, when
 * splitting, should be the same shared row (typically the split line) passed to
 * *both* regions' calls -- it phase-locks the row grid to that line instead of
 * to each region's own edge, so the region on each side has a row exactly
 * `rowSpacing/2` from the boundary rather than up to a full `rowSpacing` short
 * of it (which independently-anchored grids would leave as a visible double-wide
 * gap right where the two regions meet). Defaults to the shape's own min-Y,
 * i.e. unchanged behavior for every non-split caller. `startLeftToRight`
 * flips which side every row starts on (and therefore which side the whole
 * output's first/last stitch lands on) without changing anything else about
 * the scan -- used to pick whichever parity puts a split region's boundary
 * row on the same side as the region it needs to hand off to, instead of
 * being at the mercy of row count. */
export function tatamiRows(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  yRange?: [number, number],
  anchorY?: number,
  startLeftToRight = true,
): Point[] {
  if (polygon.length < 3) return [];
  const c = centroid(polygon);
  const rotated = polygon.map((p) => rotatePoint(p, c, -angle));
  const ys = rotated.map((p) => p.y);
  const shapeMinY = Math.min(...ys);
  const shapeMaxY = Math.max(...ys);
  const minY = yRange ? Math.max(shapeMinY, yRange[0]) : shapeMinY;
  const maxY = yRange ? Math.min(shapeMaxY, yRange[1]) : shapeMaxY;
  const spacing = Math.max(0.15, rowSpacing);
  const stitchLen = Math.max(0.2, stitchLength);
  const anchor = anchorY ?? shapeMinY;
  // First row >= minY on the grid phase-aligned to anchor + spacing/2 (mod spacing).
  const firstY = anchor + spacing / 2 + Math.ceil((minY - (anchor + spacing / 2)) / spacing) * spacing;

  const out: Point[] = [];
  let rowIndex = startLeftToRight ? 0 : 1;
  for (let y = firstY; y < maxY; y += spacing) {
    const xs = scanlineSpans(rotated, y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const leftToRight = rowIndex % 2 === 0;
      const from = leftToRight ? x0 : x1;
      const to = leftToRight ? x1 : x0;
      // Needle penetration points that line up row-to-row read as a visible
      // perforated seam. Alternating rows by half a stitch length staggers them
      // into a brick-laying pattern instead, same as Hatch's tatami fill default.
      const phase = rowIndex % 2 === 0 ? 0 : stitchLen / 2;
      const dir = to >= from ? 1 : -1;
      const startX = from + dir * phase;
      const positions: number[] = [from];
      for (let x = startX; dir > 0 ? x < to : x > to; x += dir * stitchLen) {
        if (Math.abs(x - from) > 1e-9) positions.push(x);
      }
      if (positions.length < 2 || Math.abs(positions[positions.length - 1] - to) > stitchLen * 0.25) {
        positions.push(to);
      } else {
        positions[positions.length - 1] = to;
      }
      for (const rx of positions) out.push(rotatePoint({ x: rx, y }, c, angle));
      rowIndex++;
    }
  }
  return out;
}

/** Splits a scan-line fill into independently-stitchable connected regions instead
 * of one row list covering the whole shape -- the technique real digitizing
 * software (Hatch, Ink/Stitch) uses for a genuinely non-convex outline (a
 * staircase, a star, two lobes joined by a thin waist). A single fixed scan
 * direction across such a shape has no way to know it bends: neighboring rows
 * can have completely different spans purely because the row happened to cross
 * from one "arm" of the shape to another, which `bridgeRowGaps` patches up
 * after the fact with a boundary-hugging detour on *every* such row -- reading
 * as many short repeated runs rather than a real fill. This instead groups
 * spans into connected components first (two spans in adjacent rows belong to
 * the same region when their X-ranges overlap -- the standard row-by-row
 * connected-component technique), stitches each region as its own self-
 * contained boustrophedon block, and leaves it to the caller to chain the
 * blocks together with a single travel bridge between each pair instead of
 * one per affected row. Each returned block keeps the same row-index-based
 * zigzag/stagger numbering the whole shape would have used, so regions still
 * read as normal tatami rows individually, just grouped by which connected
 * blob they belong to. */
export function connectedRegionRows(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
): Point[][] {
  if (polygon.length < 3) return [];
  const c = centroid(polygon);
  const rotated = polygon.map((p) => rotatePoint(p, c, -angle));
  const ys = rotated.map((p) => p.y);
  const shapeMinY = Math.min(...ys);
  const shapeMaxY = Math.max(...ys);
  const spacing = Math.max(0.15, rowSpacing);
  const stitchLen = Math.max(0.2, stitchLength);
  const firstY = shapeMinY + spacing / 2;

  // Topology (which spans are truly part of the same connected blob) is detected
  // on a separate, always-fine grid -- capped well below the actual output row
  // spacing -- rather than the real rows themselves. A coarse output spacing (an
  // underlay's, say, several mm apart) can be wider than a shape's own narrow
  // waist in the scan direction, skipping past it entirely; sampled at a fine
  // enough resolution instead, the waist always gets caught, so the two lobes it
  // joins are correctly recognized as one region regardless of how sparse the
  // actual stitch rows end up being. Real output spans then just look up which
  // fine-grid component they fall on.
  const detectSpacing = Math.max(0.15, Math.min(spacing, shapeMaxY - shapeMinY > 0 ? (shapeMaxY - shapeMinY) / 40 : spacing, 1));
  const detectFirstY = shapeMinY + detectSpacing / 2;

  interface FineSpan {
    x0: number;
    x1: number;
  }
  const fineRows: FineSpan[][] = [];
  for (let y = detectFirstY; y < shapeMaxY; y += detectSpacing) {
    const xs = scanlineSpans(rotated, y);
    const spans: FineSpan[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push({ x0: xs[i], x1: xs[i + 1] });
    fineRows.push(spans);
  }
  if (fineRows.length === 0) return [];

  const find = (parent: Map<string, string>, id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = id;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const parent = new Map<string, string>();
  for (let r = 0; r < fineRows.length; r++) {
    for (let s = 0; s < fineRows[r].length; s++) parent.set(`${r}:${s}`, `${r}:${s}`);
  }
  for (let r = 0; r + 1 < fineRows.length; r++) {
    for (let s = 0; s < fineRows[r].length; s++) {
      for (let t = 0; t < fineRows[r + 1].length; t++) {
        const a = fineRows[r][s];
        const b = fineRows[r + 1][t];
        if (a.x0 <= b.x1 && b.x0 <= a.x1) {
          const ra = find(parent, `${r}:${s}`);
          const rb = find(parent, `${r + 1}:${t}`);
          if (ra !== rb) parent.set(ra, rb);
        }
      }
    }
  }

  // Real output rows, at the actual requested spacing -- topology comes from the
  // fine grid above (via nearest fine-row lookup + X-overlap), not from these.
  interface Span {
    x0: number;
    x1: number;
    y: number;
    rowIndex: number; // global, matches tatamiRows' own numbering for L/R + stagger
  }
  const rows: Span[][] = [];
  let rowIndex = 0;
  for (let y = firstY; y < shapeMaxY; y += spacing) {
    const xs = scanlineSpans(rotated, y);
    const spans: Span[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      spans.push({ x0: xs[i], x1: xs[i + 1], y, rowIndex: rowIndex++ });
    }
    if (spans.length) rows.push(spans);
  }
  if (rows.length === 0) return [];

  const groups = new Map<string, Span[]>();
  for (const rowSpans of rows) {
    for (const span of rowSpans) {
      const fr = Math.min(fineRows.length - 1, Math.max(0, Math.round((span.y - detectFirstY) / detectSpacing)));
      // The nearest fine row's overlapping span decides this real span's group --
      // checking a couple of neighboring fine rows too in case the exact-nearest
      // one landed just past a boundary the real span itself is still inside.
      let root: string | null = null;
      for (const fr2 of [fr, fr - 1, fr + 1]) {
        if (fr2 < 0 || fr2 >= fineRows.length) continue;
        for (let t = 0; t < fineRows[fr2].length; t++) {
          const fs = fineRows[fr2][t];
          if (span.x0 <= fs.x1 && fs.x0 <= span.x1) {
            root = find(parent, `${fr2}:${t}`);
            break;
          }
        }
        if (root) break;
      }
      const key = root ?? `unmatched:${span.y}:${span.x0}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(span);
    }
  }

  const out: Point[][] = [];
  for (const spans of groups.values()) {
    spans.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const block: Point[] = [];
    for (const span of spans) {
      const leftToRight = span.rowIndex % 2 === 0;
      const from = leftToRight ? span.x0 : span.x1;
      const to = leftToRight ? span.x1 : span.x0;
      const phase = span.rowIndex % 2 === 0 ? 0 : stitchLen / 2;
      const dir = to >= from ? 1 : -1;
      const startX = from + dir * phase;
      const positions: number[] = [from];
      for (let x = startX; dir > 0 ? x < to : x > to; x += dir * stitchLen) {
        if (Math.abs(x - from) > 1e-9) positions.push(x);
      }
      if (positions.length < 2 || Math.abs(positions[positions.length - 1] - to) > stitchLen * 0.25) {
        positions.push(to);
      } else {
        positions[positions.length - 1] = to;
      }
      for (const rx of positions) block.push(rotatePoint({ x: rx, y: span.y }, c, angle));
    }
    out.push(block);
  }
  return out;
}

/** For a genuinely non-convex scan-fillable shape (a staircase, a star, two
 * lobes joined by a thin waist): stitches each connected region of the scan
 * (see connectedRegionRows) as its own self-contained block instead of
 * forcing one continuous scan across the whole outline, which is what
 * produces a "runs up and down the height, over and over" symptom -- a
 * single fixed direction has no way to know the shape bends, so nearly every
 * row needs its own boundary-hugging detour. Chained via ordinary
 * nearest-neighbor: starting as close to `anchor` as possible, each next
 * block is whichever remaining one (in either direction -- a block's own
 * boustrophedon is just as reversible as a full scan's) has an end closest
 * to wherever the previous block finished, joined by a single
 * perimeter-walked travel bridge each -- same "never cut across finished
 * fill" reasoning used everywhere else a bridge is needed in this engine.
 * Shared by the top fill (engine.ts, anchored on the fill's start point) and
 * a tatami/double-tatami underlay pass on a concave shape (underlay.ts,
 * anchored on the entry point) -- same technique either way, since both are
 * really just "stitch a scan-line fill of this outline." Only a handful of
 * regions ever come out of a real shape, so this greedy ordering is
 * effectively optimal in practice; a true minimum-travel ordering is a
 * genuine (NP-hard) travelling-salesman problem not worth solving exactly
 * here. */
export function regionChainRows(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  anchor: Point | null,
  step: number,
): Point[] {
  const blocks = connectedRegionRows(polygon, angle, rowSpacing, stitchLength);
  if (blocks.length === 0) return [];
  if (blocks.length === 1) return blocks[0];

  const remaining = [...blocks];
  let current: Point | null = anchor;
  const out: Point[] = [];
  while (remaining.length) {
    let bestIdx = 0;
    let bestReversed = false;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const block = remaining[i];
      const first = block[0];
      const last = block[block.length - 1];
      const costForward = current ? Math.hypot(first.x - current.x, first.y - current.y) : 0;
      const costReversed = current ? Math.hypot(last.x - current.x, last.y - current.y) : 0;
      if (costForward < bestCost) {
        bestCost = costForward;
        bestIdx = i;
        bestReversed = false;
      }
      if (costReversed < bestCost) {
        bestCost = costReversed;
        bestIdx = i;
        bestReversed = true;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    const block = bestReversed ? [...chosen].reverse() : chosen;
    if (current) {
      const first = block[0];
      if (Math.abs(current.x - first.x) > 0.05 || Math.abs(current.y - first.y) > 0.05) {
        out.push(...perimeterBridge(polygon, current, first, step));
      }
    }
    out.push(...block);
    current = block[block.length - 1];
  }
  return out;
}

/** Offsets every point of an already-fine *open* path along its own local
 * normal -- the guided-fill equivalent of offsetPolygon, but for a path with
 * two real ends rather than a closed loop. Used to generate the shifted
 * copies of a guide line that become a guided fill's rows: offset by
 * `k * rowSpacing` for k = ...,-2,-1,1,2,... and each copy still follows the
 * guide's own curve, which is the whole point -- a fixed-angle scan can't
 * bend with a shape, a set of shifted curves can. */
export function offsetOpenPath(path: Point[], amount: number): Point[] {
  return path.map((p, i) => {
    const n = normalAt(path, i);
    return { x: p.x + n.x * amount, y: p.y + n.y * amount };
  });
}

/** Extends an open path's two ends outward by `amount`, straight along each
 * end's own local tangent direction -- used to push a guide line's endpoints
 * unambiguously past a polygon's boundary before clipping (see
 * guidedFillRows for why that matters). */
function extendPathEnds(path: Point[], amount: number): Point[] {
  if (path.length < 2) return path;
  const first = path[0];
  const second = path[1];
  const len0 = dist(first, second) || 1;
  const extStart = { x: first.x + ((first.x - second.x) / len0) * amount, y: first.y + ((first.y - second.y) / len0) * amount };

  const last = path[path.length - 1];
  const secondLast = path[path.length - 2];
  const len1 = dist(last, secondLast) || 1;
  const extEnd = { x: last.x + ((last.x - secondLast.x) / len1) * amount, y: last.y + ((last.y - secondLast.y) / len1) * amount };

  return [extStart, ...path, extEnd];
}

function polygonDiagonal(polygon: Point[]): number {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Where segment a→b crosses segment p1→p2, as a fraction t along a→b (0..1),
 * or null if they don't properly cross within both segments' extent. Standard
 * 2D segment-intersection via cross products. `t` uses a half-open [0,1)
 * bound (excludes the far end) rather than the naive [0,1]: when a polyline
 * vertex sits exactly on a polygon edge -- routine for a guide line drawn to
 * meet the shape's own boundary -- that vertex is the far end (t=1) of the
 * segment arriving at it and the near end (t=0) of the segment leaving it,
 * and both would otherwise register their own crossing there, double-
 * counting a single boundary touch as two and throwing off every inside/
 * outside toggle from that point on. Excluding t=1 means only the *leaving*
 * segment's t=0 match counts, so a shared vertex is never counted twice. */
function segmentIntersectionT(a: Point, b: Point, p1: Point, p2: Point): number | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = p2.x - p1.x;
  const sy = p2.y - p1.y;
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-12) return null; // parallel (or degenerate) -- no single crossing point
  const qpx = p1.x - a.x;
  const qpy = p1.y - a.y;
  const t = (qpx * sy - qpy * sx) / rxs;
  const u = (qpx * ry - qpy * rx) / rxs;
  if (t < 0 || t >= 1 || u < 0 || u > 1) return null;
  return t;
}

/** Clips an open polyline to the portions that lie inside a closed polygon,
 * returning each inside run as its own sub-polyline (a guide line offset far
 * enough, or a concave shape, can produce more than one, or zero). Walks each
 * segment, finds every crossing with the polygon's edges, and toggles
 * inside/outside at each crossing in order -- the standard way to clip a
 * line against an arbitrary (possibly non-convex) polygon without needing
 * the polygon to be convex or the line to be straight. */
export function clipPolylineToPolygon(polyline: Point[], polygon: Point[]): Point[][] {
  if (polyline.length < 2 || polygon.length < 3) return [];
  const out: Point[][] = [];
  let current: Point[] = [];
  const flush = () => {
    if (current.length >= 2) out.push(current);
    current = [];
  };

  let inside = pointInPolygon(polyline[0], polygon);
  if (inside) current.push(polyline[0]);

  const n = polygon.length;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const crossings: number[] = [];
    for (let j = 0; j < n; j++) {
      const t = segmentIntersectionT(a, b, polygon[j], polygon[(j + 1) % n]);
      if (t !== null) crossings.push(t);
    }
    crossings.sort((x, y) => x - y);
    for (const t of crossings) {
      const pt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (inside) {
        current.push(pt);
        flush();
      } else {
        current = [pt];
      }
      inside = !inside;
    }
    if (inside) current.push(b);
  }
  flush();
  return out;
}

/** True if segments a→b and c→d cross at a point interior to both (touching
 * only at a shared endpoint doesn't count -- that's normal for consecutive
 * segments of the same path). */
function segmentsProperlyIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-12) return false;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = (qpx * sy - qpy * sx) / rxs;
  const u = (qpx * ry - qpy * rx) / rxs;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/** Whether any two non-adjacent segments of an open path cross each other --
 * the signature of an offset curve that's folded back over itself past its
 * own tightest bend. O(n²) but n is a curve-flattened guide line, at most a
 * few hundred points, so this is cheap. */
function pathSelfIntersects(path: Point[]): boolean {
  const n = path.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (segmentsProperlyIntersect(path[i], path[i + 1], path[j], path[j + 1])) return true;
    }
  }
  return false;
}

/** Generates a guided fill's rows: shifted copies of `guideLine`, offset by
 * whole multiples of `rowSpacing` in both directions, each clipped to
 * `polygon` and resampled to `stitchLength` -- boustrophedon-ordered (each
 * successive row's own direction alternates, and rows within one offset that
 * got split into several disjoint pieces by a concave boundary are each kept
 * in walk order) so the result is a single continuous scan, the same shape
 * every other row-list in this file has. Stops offsetting in a direction
 * once two offsets in a row miss the shape entirely -- past that point every
 * further copy would too, for any shape this fill technique is meant for. */
export function guidedFillRows(polygon: Point[], guideLine: Point[], rowSpacing: number, stitchLength: number): Point[] {
  if (guideLine.length < 2 || polygon.length < 3) return [];
  const spacing = Math.max(0.15, rowSpacing);
  const stitchLen = Math.max(0.2, stitchLength);
  // A guide drawn "across" the shape naturally starts/ends at or right on its
  // boundary -- exactly the case pointInPolygon's ray-cast test is unreliable
  // for (a point exactly on an edge can register as in or out depending on
  // which way the test ray happens to graze it), which otherwise shows up as
  // a spurious near-zero-length "clipped segment" right at each tip instead
  // of the real, full-length row. Extending both ends well past the
  // polygon's own extent first guarantees they're unambiguously outside, so
  // every crossing clipPolylineToPolygon finds is a real one.
  const margin = polygonDiagonal(polygon) + 1;
  const extendedGuide = extendPathEnds(guideLine, margin);

  const rowsAtOffset = (k: number): Point[][] => {
    const offsetLine = k === 0 ? extendedGuide : offsetOpenPath(extendedGuide, k * spacing);
    // A curve offset far enough past its own tightest bend folds over itself
    // (the classic "self-intersecting offset curve" problem -- offsetting
    // shrinks the inside of a bend faster than it grows the outside, and
    // past the bend's own radius the inside side crosses itself). Treating
    // that offset as a miss rather than using the corrupted, looping curve
    // is what keeps a hand-drawn guide with a tight bend from producing a
    // chaotic tangle of stitches instead of just stopping short of it.
    if (k !== 0 && pathSelfIntersects(offsetLine)) return [];
    return clipPolylineToPolygon(offsetLine, polygon);
  };

  const collect = (direction: 1 | -1): Point[][][] => {
    const groups: Point[][][] = [];
    let misses = 0;
    for (let k = direction; misses < 2 && Math.abs(k) < 4000; k += direction) {
      const segs = rowsAtOffset(k);
      if (segs.length === 0) {
        misses++;
      } else {
        misses = 0;
        groups.push(segs);
      }
    }
    return groups;
  };

  const negative = collect(-1).reverse(); // far side first, walking back toward the guide
  const center = rowsAtOffset(0);
  const positive = collect(1);
  const allGroups = [...negative, center, ...positive];

  const out: Point[] = [];
  let rowIndex = 0;
  for (const segs of allGroups) {
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const resampled = resamplePath(seg, stitchLen);
      const ordered = rowIndex % 2 === 0 ? resampled : [...resampled].reverse();
      out.push(...ordered);
      rowIndex++;
    }
  }
  return out;
}
