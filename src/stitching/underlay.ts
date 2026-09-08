import type { EmbObject, Point, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { dist, normalAt, offsetPolygon, polygonArea, resamplePath, tatamiRows } from './geometry';

// A fill underlay sits entirely inside the top stitching's coverage — roughly one
// thread width in from the digitized outline — so none of its own stitches (the
// scanline rows' row-ends, or an edge-run pass tracing the perimeter) can end up
// poking out past where the top layer actually covers, which reads as a ragged,
// not-flush edge even though the top stitching itself is fine.
const UNDERLAY_INSET_MM = 0.4;

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
    // Double-tatami's two crossed passes read as visibly "busy" next to the top
    // stitching in preview (each pass alone is properly sparse relative to the
    // top rows, but combined they can look like broken/uneven coverage) -- kept
    // for genuinely large fills where that extra cross-stability actually
    // matters, not defaulted to for anything mid-sized.
    if (area < 900) return 'tatami';
    return 'double-tatami';
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

/** Trims `path` so it starts `distance` further along by arc length — used to shift
 * a resample's starting phase, e.g. so a second zigzag pass lands in the gaps left
 * by the first instead of retracing the same points. */
function trimPathStart(path: Point[], distance: number): Point[] {
  if (distance <= 0 || path.length < 2) return path;
  let remaining = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    // Strictly less-than (with a small epsilon), not <=: when the trim distance lands
    // exactly on an existing vertex, falling through to the next iteration instead of
    // inserting a synthetic point here avoids creating a point that coincides with `b`
    // — a duplicate that gives normalAt a zero-length neighbor pair (a degenerate
    // normal), which threw off every offset/resample computed from it downstream.
    if (remaining < segLen - 1e-9) {
      const t = remaining / segLen;
      const start = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      return [start, ...path.slice(i)];
    }
    remaining -= segLen;
  }
  return [path[path.length - 1]];
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

function zigzag(
  centerline: Point[],
  width: number,
  spacing: number,
  widthFactor: number,
  phase: 1 | -1,
  offset = 0,
): Point[] {
  const half = (width / 2) * widthFactor;
  const step = Math.max(0.4, spacing);
  const path = trimPathStart(centerline, offset);
  const posRail = resamplePath(offsetPath(path, half), step);
  const negRail = resamplePath(offsetPath(path, -half), step);
  const n = Math.min(posRail.length, negRail.length);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const onPos = (i % 2 === 0) === (phase === 1);
    out.push(onPos ? posRail[i] : negRail[i]);
  }
  return out;
}

/** A real double-zigzag underlay: pass 1 zigzags forward corner-to-corner, then pass 2
 * zigzags the same width back the way it came, offset by half a stitch so it lands in
 * the gaps pass 1 left rather than retracing it — doubling the crossing density instead
 * of just stitching the same zigzag twice. */
function doubleZigzag(centerline: Point[], width: number, spacing: number): Point[] {
  const widthFactor = 0.6; // same width as a single zigzag pass
  const pass1 = zigzag(centerline, width, spacing, widthFactor, 1, 0);
  const pass2 = zigzag(centerline, width, spacing, widthFactor, 1, spacing / 2);
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
    // tatami/double-tatami are a fill concept (straight rows across an area), not a
    // column one — there's no UI path to select them for a satin, but old saved data
    // could have one, so fall back to the closest column equivalent rather than no-op.
    case 'tatami':
      return zigzag(centerline, width, spacing, 0.6, 1);
    case 'double-tatami':
      return doubleZigzag(centerline, width, spacing);
    default:
      return [];
  }
}

/** Generates the underlay pass for a fill area. `polygon` is the (already
 * curve-flattened, closed) outline. `topAngle` is the fill's own top-stitch angle,
 * so tatami underlay can run perpendicular to it as is standard practice. */
export function fillUnderlay(polygon: Point[], topAngle: number, settings: UnderlaySettings, type: UnderlayType): Point[] {
  if (type === 'none' || polygon.length < 3) return [];
  const inset = offsetPolygon(polygon, -UNDERLAY_INSET_MM);
  const spacing = settings.spacing;
  switch (type) {
    case 'center-run':
      return centerRun(inset, true, spacing);
    case 'edge-run':
      return edgeRunFill(inset, spacing);
    case 'tatami':
      // A scanline fill only touches two of the four sides at each row's endpoint —
      // it never actually walks along the other two, which is exactly the "gap" a
      // plain tatami underlay leaves at the perimeter. Adding the perimeter trace
      // here (rather than requiring the user to add it as a separate Underlay 2
      // pass) makes "tatami" mean fully-stabilized-including-the-edge by default.
      return [...edgeRunFill(inset, spacing), ...tatamiRows(inset, topAngle + 90, spacing, spacing * 1.5)];
    case 'double-tatami': {
      // One pass perpendicular to the top stitching, one parallel to it -- a crossed
      // grid (horizontal one way, vertical the other), not the same direction twice.
      const passA = tatamiRows(inset, topAngle + 90, spacing, spacing * 1.5);
      const passB = tatamiRows(inset, topAngle, spacing, spacing * 1.5);
      return [...edgeRunFill(inset, spacing), ...passA, ...passB];
    }
    // zigzag/double-zigzag are a column (satin) concept -- an angled bounce stitch --
    // not a fill one; there's no UI path to select them for a fill, but old saved data
    // could have one, so fall back to the nearest fill equivalent rather than no-op.
    case 'zigzag':
      return tatamiRows(inset, topAngle + 90, spacing, spacing * 1.5);
    case 'double-zigzag': {
      const passA = tatamiRows(inset, topAngle + 90, spacing, spacing * 1.5);
      const passB = tatamiRows(inset, topAngle, spacing, spacing * 1.5);
      return [...passA, ...passB];
    }
    default:
      return [];
  }
}
