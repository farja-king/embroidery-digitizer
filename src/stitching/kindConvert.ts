import type { PathPoint, StitchKind } from '../types';

/** A fill's points form an implicitly-closed loop (the stitch engine always connects
 * last back to first); a running/satin path doesn't. So converting fill -> outline
 * needs an explicit closing point, or the outline would be missing that final edge. */
function closeLoop(points: PathPoint[]): PathPoint[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const alreadyClosed = Math.hypot(first.x - last.x, first.y - last.y) < 0.01;
  return alreadyClosed ? points : [...points, { ...first }];
}

export function pointsForKindChange(fromKind: StitchKind, toKind: StitchKind, points: PathPoint[]): PathPoint[] {
  return fromKind === 'fill' && toKind !== 'fill' ? closeLoop(points) : points;
}
