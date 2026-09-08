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
 * a tatami underlay pass underneath it (at a different angle/spacing). */
export function tatamiRows(polygon: Point[], angle: number, rowSpacing: number, stitchLength: number): Point[] {
  if (polygon.length < 3) return [];
  const c = centroid(polygon);
  const rotated = polygon.map((p) => rotatePoint(p, c, -angle));
  const ys = rotated.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spacing = Math.max(0.15, rowSpacing);
  const stitchLen = Math.max(0.2, stitchLength);

  const out: Point[] = [];
  let rowIndex = 0;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
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
