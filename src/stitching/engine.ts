import type { EmbObject, Point } from '../types';
import { centroid, normalAt, resamplePath, rotatePoint, scanlineSpans } from './geometry';

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

function satinStitches(points: Point[], width: number, density: number, underlay: boolean): StitchPoint[] {
  const sampled = resamplePath(points, Math.max(0.2, density));
  const out: StitchPoint[] = [];
  if (underlay) {
    // Simple centerline running-stitch pass to stabilize the fabric before the column.
    for (const p of sampled) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  }
  const half = width / 2;
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

function fillStitches(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  underlay: boolean,
): StitchPoint[] {
  if (polygon.length < 3) return [];
  const c = centroid(polygon);
  const rotated = polygon.map((p) => rotatePoint(p, c, -angle));
  const ys = rotated.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spacing = Math.max(0.15, rowSpacing);
  const stitchLen = Math.max(0.2, stitchLength);

  const out: StitchPoint[] = [];

  if (underlay) {
    // Perimeter walk stitch as a light underlay.
    const closed = [...polygon, polygon[0]];
    for (const p of closed) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  }

  let rowIndex = 0;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    const xs = scanlineSpans(rotated, y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const leftToRight = rowIndex % 2 === 0;
      const from = leftToRight ? x0 : x1;
      const to = leftToRight ? x1 : x0;
      const span = Math.abs(to - from);
      const steps = Math.max(1, Math.round(span / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const rx = from + (to - from) * t;
        const rp = rotatePoint({ x: rx, y }, c, angle);
        out.push({ x: rp.x, y: rp.y, command: 'STITCH' });
      }
      rowIndex++;
    }
  }
  return out;
}

export function generateObjectStitches(obj: EmbObject): StitchPoint[] {
  if (!obj.visible || obj.points.length < 2) return [];
  switch (obj.kind) {
    case 'running':
      return runningStitches(obj.points, obj.running.stitchLength, obj.running.triple);
    case 'satin':
      return satinStitches(obj.points, obj.satin.width, obj.satin.density, obj.satin.underlay);
    case 'fill':
      return fillStitches(
        obj.points,
        obj.fill.angle,
        obj.fill.rowSpacing,
        obj.fill.stitchLength,
        obj.fill.underlay,
      );
    default:
      return [];
  }
}

export interface BuiltPattern {
  stitches: StitchPoint[];
  threads: { r: number; g: number; b: number }[];
}

const MAX_STITCH_MM = 12.1; // ~121 units of 0.1mm, the tightest ceiling among the four formats (DST/EXP)

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
export function buildPattern(objects: EmbObject[]): BuiltPattern {
  const visible = objects.filter((o) => o.visible && o.points.length >= 2);
  const stitches: StitchPoint[] = [];
  const threads: { r: number; g: number; b: number }[] = [];
  // The machine always starts at (0,0); the very first object needs a JUMP to
  // reach it too, same as every jump between objects after it.
  let cursor: Point = { x: 0, y: 0 };
  let started = false;
  let lastColorKey = '';

  for (const obj of visible) {
    const objStitches = generateObjectStitches(obj);
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
      // JUMP does the moving; TRIM (if warranted) is a zero-delta "cut here" marker
      // placed once we've already arrived, which is the convention every format below expects.
      const hops = splitLongJump(cursor, first);
      for (const hop of hops) stitches.push({ x: hop.x, y: hop.y, command: 'JUMP' });
      if (jumpDist > 4) stitches.push({ x: first.x, y: first.y, command: 'TRIM' });
    }

    for (const sp of objStitches) stitches.push(sp);
    cursor = { x: objStitches[objStitches.length - 1].x, y: objStitches[objStitches.length - 1].y };
    started = true;
  }

  if (started) stitches.push({ x: cursor.x, y: cursor.y, command: 'END' });
  return { stitches: clampLongStitches(stitches), threads };
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
