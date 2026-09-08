import { dist, pathLength, polygonArea } from '../stitching/geometry';
import type { Point } from '../types';

/** Resamples a polyline to exactly `n` points, evenly spaced by arc length
 * (unlike geometry.ts's resamplePath, which resamples at a fixed *step* and so
 * can land on a slightly different point count depending on path length) --
 * needed here so two independently-walked rails always end up with the same
 * number of points to pair against each other, *by matching fraction along
 * each rail's own length* rather than by raw index -- which is what makes this
 * correct even when one rail is physically longer than the other (the outer
 * vs. inner curve of a bent stroke like "C" or "S"). */
function resampleToCount(points: Point[], n: number): Point[] {
  if (points.length === 0) return [];
  const total = pathLength(points);
  if (total < 1e-9) return new Array(n).fill(points[0]);
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    out.push(pointAtArcLength(points, (k / (n - 1)) * total));
  }
  return out;
}

function pointAtArcLength(points: Point[], target: number): Point {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = dist(points[i - 1], points[i]);
    if (acc + segLen >= target || i === points.length - 1) {
      const t = segLen > 1e-9 ? Math.max(0, Math.min(1, (target - acc) / segLen)) : 0;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    acc += segLen;
  }
  return points[points.length - 1];
}

export interface SatinCenterline {
  centerline: Point[];
  width: number; // mm -- a single average width; the engine's satin model doesn't taper
}

interface ScoredCenterline extends SatinCenterline {
  score: number; // relative width variation, lower = a cleaner/more consistent stroke
}

const RAIL_SAMPLES = 28;

// Splitting a closed loop at two points always produces two arcs sharing
// those exact two points as their start/end -- meaning railA[0] and railB[0]
// (and the two rails' last points) are the *same physical point* no matter
// which two points were chosen, so the paired "width" there is mathematically
// zero for every candidate, good or bad. That's not a signal of anything --
// it's just what cutting a loop always looks like -- so the consistency check
// below deliberately ignores a margin at each end and only judges the width
// profile in between, where a genuine single stroke actually is versus isn't
// consistent.
const END_MARGIN = 3; // samples excluded from each end of RAIL_SAMPLES

/** Checks that two paired, equal-*point-count* rails (see resampleToCount)
 * actually describe a clean single stroke -- consistent width along its
 * length, and a centerline that doesn't double back on itself -- rather than
 * something a branch point or a bad end-cap split produced. Returns null
 * (meaning "not a valid ribbon split") when the shape doesn't hold up. */
function railsToCenterline(railA: Point[], railB: Point[]): ScoredCenterline | null {
  const a = resampleToCount(railA, RAIL_SAMPLES);
  const b = resampleToCount(railB, RAIL_SAMPLES);
  const widths = a.map((p, k) => dist(p, b[k]));
  const middle = widths.slice(END_MARGIN, widths.length - END_MARGIN);
  if (middle.length === 0) return null;
  const avgWidth = middle.reduce((s, w) => s + w, 0) / middle.length;
  if (avgWidth < 0.3) return null; // too thin to be a real digitized stroke
  const maxWidth = Math.max(...middle);
  const minWidth = Math.min(...middle);
  // A real letter stroke's width stays roughly consistent along its length; a
  // wildly varying width (or one that pinches near zero) means the two rails
  // aren't actually opposite sides of one stroke -- most often because the
  // split point cut across a branch, or isn't really where the stroke ends.
  if (maxWidth > avgWidth * 2.5 || minWidth < avgWidth * 0.25) return null;

  const centerline = a.map((p, k) => ({ x: (p.x + b[k].x) / 2, y: (p.y + b[k].y) / 2 }));
  // A branch point also tends to show up as the centerline itself doubling
  // back sharply rather than following one smooth path end to end. Same end
  // margin as the width check -- right at the shared cut points the two
  // rails converge, which can make the centerline's direction near the very
  // ends noisy in a way that says nothing about the stroke itself.
  for (let k = Math.max(1, END_MARGIN); k < centerline.length - Math.max(1, END_MARGIN); k++) {
    const v1 = { x: centerline[k].x - centerline[k - 1].x, y: centerline[k].y - centerline[k - 1].y };
    const v2 = { x: centerline[k + 1].x - centerline[k].x, y: centerline[k + 1].y - centerline[k].y };
    const len1 = Math.hypot(v1.x, v1.y) || 1;
    const len2 = Math.hypot(v2.x, v2.y) || 1;
    const cos = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
    if (cos < -0.5) return null;
  }
  return { centerline, width: avgWidth, score: (maxWidth - minWidth) / avgWidth };
}

/** Cumulative arc length at each vertex of a *closed* contour, walking
 * forward including the closing edge back to vertex 0. `cum[n]` is the total
 * perimeter. */
function closedCumulative(contour: Point[]): number[] {
  const n = contour.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + dist(contour[i], contour[(i + 1) % n]));
  return cum;
}

/** Extracts the sub-path of a closed contour from arc-length `start` to `end`
 * (both absolute, `end` may exceed the perimeter to mean "wrap around"),
 * interpolating exact points at both ends. Works by conceptually walking the
 * contour twice in a row so a wrapping span never needs modular-arithmetic
 * edge cases -- `start`/`end` just index straight into that doubled walk. */
function railBetween(contour: Point[], cum: number[], start: number, end: number): Point[] {
  const n = contour.length;
  const total = cum[n];
  const cum2: number[] = [];
  const pts2: Point[] = [];
  for (let rep = 0; rep < 2; rep++) {
    for (let i = 0; i < n; i++) {
      cum2.push(cum[i] + rep * total);
      pts2.push(contour[i]);
    }
  }
  cum2.push(2 * total);
  pts2.push(contour[0]);

  const interp = (s: number): Point => {
    for (let i = 0; i < cum2.length - 1; i++) {
      if (s >= cum2[i] && s <= cum2[i + 1]) {
        const segLen = cum2[i + 1] - cum2[i];
        const t = segLen > 1e-9 ? (s - cum2[i]) / segLen : 0;
        const a = pts2[i];
        const b = pts2[i + 1];
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
    }
    return pts2[pts2.length - 1];
  };

  const out: Point[] = [interp(start)];
  for (let i = 0; i < cum2.length; i++) {
    if (cum2[i] > start && cum2[i] < end) out.push(pts2[i]);
  }
  out.push(interp(end));
  return out;
}

/** Attempts to read a single closed, hole-free glyph contour as one satin
 * stroke. Rather than analytically deriving where a stroke's two "end caps"
 * are -- which has no one formula that works for both a straight rectangular
 * stem ("I", "l") and a strongly curved hook ("C", "S": for those, even the
 * two long *sides* have different lengths, the outer arc vs. the inner one,
 * so a fixed-axis or farthest-point heuristic picks the wrong split -- this
 * tries splitting the contour at many evenly-spaced candidate points (paired
 * with the point exactly half the perimeter away) and keeps whichever split
 * produces the most width-consistent pair of rails. A real single stroke has
 * at least one such split that reads cleanly; a branching letter ("A", "E",
 * "F", "T", "Y", "K", "R", ...) has none, which is exactly the signal to fall
 * back to a fill object instead of forcing a distorted satin column. */
export function ribbonToSatin(contour: Point[]): SatinCenterline | null {
  if (contour.length < 4) return null;
  const cum = closedCumulative(contour);
  const total = cum[contour.length];
  if (total < 1e-6) return null;
  const trueArea = Math.abs(polygonArea(contour));

  const CANDIDATES = 24;
  let best: ScoredCenterline | null = null;
  for (let c = 0; c < CANDIDATES; c++) {
    const start = (c / CANDIDATES) * total;
    const half = start + total / 2;
    const railA = railBetween(contour, cum, start, half);
    const railB = [...railBetween(contour, cum, half, start + total)].reverse();
    const result = railsToCenterline(railA, railB);
    if (!result) continue;
    // Width consistency alone isn't enough to prove this is a genuine single
    // stroke: a branching letter ("E", "T", "K", ...) can still produce a
    // numerically smooth width profile from an essentially arbitrary 2-point
    // cut, since going around several corners can make the *traced* rail
    // path long even on a shape that isn't elongated at all in a straight-
    // line sense. Compare width against the *straight-line* distance between
    // the two cut points instead of the winding rail length -- a real
    // stroke's two ends are genuinely far apart; a false-positive cut through
    // a compact branching shape's ends usually aren't.
    const capSpan = dist(railA[0], railA[railA.length - 1]);
    if (result.width > capSpan * 0.4) continue;
    // Strongest check: a real single stroke's own area (width × length, the
    // ribbon's own footprint) should closely match the original contour's
    // true area -- nothing extra, nothing missing. A false-positive cut
    // through a branching letter passes the checks above but leaves real
    // area of the glyph outside what the fitted ribbon actually covers (the
    // other branch, or a corner the cut sliced past), which this catches
    // even when the local width profile alone looked clean.
    const ribbonArea = result.width * pathLength(result.centerline);
    if (Math.abs(ribbonArea - trueArea) > trueArea * 0.2) continue;
    if (!best || result.score < best.score) best = result;
  }
  return best;
}

/** Attempts to read an outer contour + its one hole (an "O", "D", "Q", "o", ...)
 * as a satin ring: the outer and inner boundaries are already the two rails of
 * the stroke, no splitting needed -- just paired up by matching rotational
 * phase around the shape's centroid so corresponding points on each side line
 * up instead of being paired arbitrarily. Falls back to null (use fill) for
 * anything that isn't actually a clean, consistent-width ring -- e.g. "e",
 * whose hole doesn't run all the way around. */
export function ringToSatin(outer: Point[], hole: Point[]): SatinCenterline | null {
  if (outer.length < 6 || hole.length < 6) return null;
  const c = centroidOf(outer);
  const angleOf = (p: Point) => Math.atan2(p.y - c.y, p.x - c.x);
  const outerStartAngle = angleOf(outer[0]);
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let k = 0; k < hole.length; k++) {
    const diff = Math.abs(angularDelta(angleOf(hole[k]), outerStartAngle));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = k;
    }
  }
  let holeAligned = [...hole.slice(bestIdx), ...hole.slice(0, bestIdx)];
  // TrueType/OpenType convention winds a hole opposite to its outer -- reverse
  // it so both rails are walked in the same rotational direction. Determined
  // via signed area (nonzero and reliable for any contour) rather than the
  // angle between two adjacent points, which can land on exactly 0 -- and
  // silently fail to detect a real direction mismatch -- when a glyph's path
  // starts with a degenerate zero-length "M then L to the same point" pair,
  // which real font outlines (Arial's "O" included) do produce.
  if (Math.sign(signedArea(outer)) !== Math.sign(signedArea(holeAligned))) {
    holeAligned = [holeAligned[0], ...holeAligned.slice(1).reverse()];
  }
  const result = railsToCenterline(outer, holeAligned);
  if (!result) return null;
  // Same area sanity check as ribbonToSatin: a genuine ring's own footprint
  // (width × its centerline's length) should closely match outer-minus-hole,
  // the true annular area -- catches a shape like "e" that superficially
  // paired well enough to pass the local width check but isn't actually a
  // clean ring (its hole doesn't run all the way around).
  const trueArea = Math.abs(polygonArea(outer)) - Math.abs(polygonArea(hole));
  const ringArea = result.width * pathLength(result.centerline);
  if (Math.abs(ringArea - trueArea) > trueArea * 0.35) return null;
  return result;
}

function centroidOf(points: Point[]): Point {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

function signedArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a / 2;
}

function angularDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
