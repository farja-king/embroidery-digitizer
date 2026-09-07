import type { Point } from '../types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Resample an open polyline at fixed arc-length steps. Always includes the first
 * and last point of the original path. */
export function resamplePath(points: Point[], step: number): Point[] {
  if (points.length < 2 || step <= 0) return points.slice();
  const out: Point[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    let travelled = carry;
    while (travelled + step <= segLen) {
      travelled += step;
      const t = travelled / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    carry = step - (segLen - travelled); // overshoot carried into next segment
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
