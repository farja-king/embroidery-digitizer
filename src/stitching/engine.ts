import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { flattenPath, normalAt, offsetPolygon, perimeterBridge, resamplePath, tatamiRows } from './geometry';
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

function fillStitches(
  polygon: Point[],
  angle: number,
  rowSpacing: number,
  stitchLength: number,
  underlayPts: Point[],
  pullCompensation: number,
  startPoint: Point | null,
  endPoint: Point | null,
): StitchPoint[] {
  if (polygon.length < 3) return [];
  const out: StitchPoint[] = [];
  for (const p of underlayPts) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  // Dense fill stitching pulls the fabric in toward the shape's center, so the top
  // layer is generated slightly past the digitized outline to come out true-to-size
  // on fabric — the underlay above deliberately stays on the original boundary
  // (actually inset from it), so it can never poke out past this expanded edge.
  const expanded = offsetPolygon(polygon, Math.max(0, pullCompensation));
  const rows = tatamiRows(expanded, angle, rowSpacing, stitchLength);
  // A boustrophedon scan's two natural ends are always at opposite Y-extremes of
  // the shape (relative to the fill angle) -- reversing the whole point sequence
  // is still a valid scan (each row's own internal direction flips too, so the
  // zigzag stays consistent), just walked from the other end. Picking whichever
  // direction lands its *natural finish* closer to the desired end point (or
  // start, if no end is set) is the real fix for a long "funky line" bridge back
  // across the fill -- professional digitizing software doesn't achieve exact
  // start=end by bridging either, it achieves it by choosing scan direction so
  // the fill *naturally* finishes back near the entry, with the underlay (already
  // handled by the entry bridge below) doing the one-way "delivery" to the far
  // side first.
  if (rows.length > 1 && (startPoint || endPoint)) {
    // Prioritize the end point when both are set: that's what determines whether
    // the *next* same-color shape can flow on without a trim, which is the whole
    // reason this exists. Only the entry side is otherwise unconstrained.
    const optimizingForEnd = !!endPoint;
    const target = (endPoint ?? startPoint)!;
    const distFirst = Math.hypot(rows[0].x - target.x, rows[0].y - target.y);
    const distLast = Math.hypot(rows[rows.length - 1].x - target.x, rows[rows.length - 1].y - target.y);
    const shouldReverse = optimizingForEnd ? distFirst < distLast : distLast < distFirst;
    if (shouldReverse) rows.reverse();
  }
  for (const p of rows) out.push({ x: p.x, y: p.y, command: 'STITCH' });
  // The scan naturally finishes wherever the last row happens to end -- if the user
  // dragged the end marker somewhere else (to line up with the next same-color
  // shape's start, say), bridge there along the shape's own edge instead of leaving
  // it wherever the scan stopped, so buildPattern's jump from here is short and
  // deliberate rather than a straight line back across the shape's interior.
  const lastRowPoint = rows[rows.length - 1];
  if (endPoint && lastRowPoint && (Math.abs(lastRowPoint.x - endPoint.x) > 0.05 || Math.abs(lastRowPoint.y - endPoint.y) > 0.05)) {
    for (const p of perimeterBridge(expanded, lastRowPoint, endPoint, Math.max(0.4, stitchLength))) {
      out.push({ x: p.x, y: p.y, command: 'STITCH' });
    }
  }
  // Same idea at the front: the scan (or underlay, if it runs first) naturally
  // begins wherever it begins -- rotating the outline's own points changes that
  // only incidentally. An explicit start point gets its own bridge walked
  // backwards from wherever generation actually starts, so this object's very
  // first stitch is exactly where the user put it (e.g. matching the end point of
  // whatever same-color shape stitches right before this one).
  const naturalFirst = out[0];
  if (startPoint && naturalFirst && (Math.abs(naturalFirst.x - startPoint.x) > 0.05 || Math.abs(naturalFirst.y - startPoint.y) > 0.05)) {
    const bridge = perimeterBridge(polygon, startPoint, naturalFirst, Math.max(0.4, stitchLength));
    const lead: StitchPoint[] = [{ x: startPoint.x, y: startPoint.y, command: 'STITCH' }];
    for (const p of bridge.slice(0, -1)) lead.push({ x: p.x, y: p.y, command: 'STITCH' });
    out.unshift(...lead);
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
        fillUnderlay(flat, obj.fill.angle, settings, type),
      );
      return fillStitches(
        flat,
        obj.fill.angle,
        obj.fill.rowSpacing,
        obj.fill.stitchLength,
        underlayPts,
        obj.fill.pullCompensation ?? 0,
        obj.fill.startPoint ?? null,
        obj.fill.endPoint ?? null,
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

  if (started) stitches.push({ x: cursor.x, y: cursor.y, command: 'END' });
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
