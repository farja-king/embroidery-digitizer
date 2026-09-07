import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { normalAt, polygonArea, resamplePath, tatamiRows } from './geometry';

const NO_UNDERLAY: UnderlaySettings = { mode: 'manual', type: 'none', spacing: 2.5 };

/** Accepts both the current two-pass shape and an older single-pass `UnderlaySettings`
 * (from a project saved before pass 2 existed, or no underlay field at all) so opening
 * an old project file doesn't crash — it just reads as "pass 1 only". */
export function normalizeUnderlay(field: TwoPassUnderlay | UnderlaySettings | undefined | null): TwoPassUnderlay {
  if (!field) return { pass1: NO_UNDERLAY, pass2: NO_UNDERLAY };
  if ('pass1' in field) return field;
  return { pass1: field, pass2: NO_UNDERLAY };
}

/** Picks a sensible underlay type from the object's own dimensions, the way a human
 * digitizer would by rule of thumb — used when underlay.mode === 'auto'. */
export function autoUnderlayType(obj: EmbObject): UnderlayType {
  if (obj.kind === 'satin') {
    const w = obj.satin.width;
    if (w < 1.5) return 'none'; // too narrow to need stabilizing
    if (w < 4) return 'center-run';
    if (w < 8) return 'zigzag';
    return 'double-zigzag';
  }
  if (obj.kind === 'fill') {
    const area = Math.abs(polygonArea(obj.points));
    if (area < 30) return 'edge-run'; // small shape: just walk the perimeter
    return 'tatami';
  }
  return 'none';
}

function centerRun(centerline: Point[], closed: boolean, spacing: number): Point[] {
  const path = closed ? [...centerline, centerline[0]] : centerline;
  return resamplePath(path, Math.max(0.4, spacing));
}

/** Offsets every point of an already-fine path along its own local normal. Doing this
 * at the path's full (fine) resolution — rather than computing normals from a coarse
 * resample first — is what keeps the offset curve accurate on a tight bend; normals
 * estimated from far-apart points cut corners and can swing outside the satin's own
 * width on a curve, which is what was happening before this existed. */
function offsetPath(fine: Point[], amount: number): Point[] {
  return fine.map((p, i) => {
    const n = normalAt(fine, i);
    return { x: p.x + n.x * amount, y: p.y + n.y * amount };
  });
}

function edgeRunSatin(centerline: Point[], width: number, spacing: number): Point[] {
  const half = (width / 2) * 0.85; // inset slightly from the final satin edge
  const step = Math.max(0.4, spacing);
  const rail1 = resamplePath(offsetPath(centerline, half), step);
  const rail2 = resamplePath(offsetPath(centerline, -half), step);
  return [...rail1, ...rail2.reverse()];
}

function edgeRunFill(polygon: Point[], spacing: number): Point[] {
  return resamplePath([...polygon, polygon[0]], Math.max(0.4, spacing));
}

function zigzag(centerline: Point[], width: number, spacing: number, widthFactor: number, phase: 1 | -1): Point[] {
  const half = (width / 2) * widthFactor;
  const step = Math.max(0.4, spacing);
  const posRail = resamplePath(offsetPath(centerline, half), step);
  const negRail = resamplePath(offsetPath(centerline, -half), step);
  const n = Math.min(posRail.length, negRail.length);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const onPos = (i % 2 === 0) === (phase === 1);
    out.push(onPos ? posRail[i] : negRail[i]);
  }
  return out;
}

function doubleZigzag(centerline: Point[], width: number, spacing: number): Point[] {
  const pass1 = zigzag(centerline, width, spacing, 0.65, 1);
  const pass2 = zigzag(centerline, width, spacing, 0.4, -1);
  return [...pass1, ...pass2.reverse()];
}

/** Generates the underlay pass for a satin column, in the same design-space mm the
 * rest of the stitch engine works in. `centerline` is the (already curve-flattened,
 * open) path the satin column follows. */
export function satinUnderlay(centerline: Point[], width: number, settings: UnderlaySettings, type: UnderlayType): Point[] {
  if (type === 'none' || centerline.length < 2) return [];
  const spacing = settings.spacing;
  switch (type) {
    case 'center-run':
      return centerRun(centerline, false, spacing);
    case 'edge-run':
      return edgeRunSatin(centerline, width, spacing);
    case 'zigzag':
      return zigzag(centerline, width, spacing, 0.6, 1);
    case 'double-zigzag':
      return doubleZigzag(centerline, width, spacing);
    case 'tatami':
      // Not a natural fit for a narrow column — fall back to the closest equivalent.
      return zigzag(centerline, width, spacing, 0.6, 1);
    default:
      return [];
  }
}

/** Generates the underlay pass for a fill area. `polygon` is the (already
 * curve-flattened, closed) outline. `topAngle` is the fill's own top-stitch angle,
 * so tatami underlay can run perpendicular to it as is standard practice. */
export function fillUnderlay(polygon: Point[], topAngle: number, settings: UnderlaySettings, type: UnderlayType): Point[] {
  if (type === 'none' || polygon.length < 3) return [];
  const spacing = settings.spacing;
  switch (type) {
    case 'center-run':
      return centerRun(polygon, true, spacing);
    case 'edge-run':
      return edgeRunFill(polygon, spacing);
    case 'tatami':
      return tatamiRows(polygon, topAngle + 90, spacing, spacing * 1.5);
    case 'zigzag':
    case 'double-zigzag':
      // Zigzag underlay is a satin-column idea; for a fill area, a sparse
      // perpendicular tatami pass is the closest sensible equivalent.
      return tatamiRows(polygon, topAngle + 90, spacing, spacing * 1.5);
    default:
      return [];
  }
}
