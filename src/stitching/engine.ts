import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { flattenPath, normalAt, resamplePath, tatamiRows } from './geometry';
import { autoUnderlayType, fillUnderlay, normalizeUnderlay, satinUnderlay } from './underlay';

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

function satinStitches(points: Point[], width: number, density: number, underlayPts: Point[]): StitchPoint[] {
  const sampled = resamplePath(points, Math.max(0.2, density));
  const out: StitchPoint[] = [];
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });
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
  underlayPts: Point[],
): StitchPoint[] {
  if (polygon.length < 3) return [];
  const out: StitchPoint[] = [];
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  for (const p of tatamiRows(polygon, angle, rowSpacing, stitchLength)) {
    out.push({ x: p.x, y: p.y, command: 'STITCH' });
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
      return satinStitches(flat, obj.satin.width, obj.satin.density, underlayPts);
    }
    case 'fill': {
      const underlayPts = resolveUnderlay(obj, obj.fill.underlay, (settings, type) =>
        fillUnderlay(flat, obj.fill.angle, settings, type),
      );
      return fillStitches(flat, obj.fill.angle, obj.fill.rowSpacing, obj.fill.stitchLength, underlayPts);
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
      // JUMP does the moving; TRIM (if warranted) is a zero-delta "cut here" marker
      // placed once we've already arrived, which is the convention every format below expects.
      const hops = splitLongJump(cursor, first);
      for (const hop of hops) stitches.push({ x: hop.x, y: hop.y, command: 'JUMP' });
      if (jumpDist >= trimThresholdMm) stitches.push({ x: first.x, y: first.y, command: 'TRIM' });
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
