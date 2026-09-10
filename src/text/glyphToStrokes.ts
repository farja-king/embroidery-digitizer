import type { Point } from '../types';

/** One stroke of a letter: a centreline to run a satin column along, and the
 * width that column should be. This is the "primitive" a digitized embroidery
 * font is built from -- the two legs and the crossbar of an "A" are three of
 * them, each with its own direction, which is why the stitches in a real
 * digitized letter turn to follow the stroke instead of all running one way. */
export interface Stroke {
  centerline: Point[];
  width: number;
  // Half-width at each centreline point, so the column can follow a stroke that
  // tapers or is cut flat at an angle instead of being a constant-width band
  // that spills out of the letter at every end. Same length as `centerline`.
  halfWidths: number[];
}

// Working resolution for the raster stage, in samples per millimetre. High
// enough that a thin stroke is still several pixels across (so thinning finds a
// clean skeleton) without making the grid big enough to be slow: a 20mm capital
// comes out around 260 pixels tall.
const SAMPLES_PER_MM = 13;
// A skeleton branch shorter than this multiple of the local stroke width is a
// spur thrown off by a corner, not a real stroke of the letter.
const SPUR_FACTOR = 1.15;

interface Raster {
  w: number;
  h: number;
  inside: Uint8Array;
  originX: number;
  originY: number;
  scale: number; // pixels per mm
}

/** Fills the glyph's contours into a pixel grid using the even-odd rule, so a
 * counter (the hole in "O", "A", "e") comes out as background exactly the way
 * the font intends. */
function rasterize(contours: Point[][], pad: number): Raster | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!isFinite(minX)) return null;
  const scale = SAMPLES_PER_MM;
  const w = Math.ceil((maxX - minX) * scale) + pad * 2 + 1;
  const h = Math.ceil((maxY - minY) * scale) + pad * 2 + 1;
  if (w < 3 || h < 3 || w * h > 4000000) return null;
  const originX = minX - pad / scale;
  const originY = minY - pad / scale;
  const inside = new Uint8Array(w * h);

  // Scanline through pixel centres. Crossings from every contour go into one
  // list, so the even-odd rule handles outers and holes together.
  for (let py = 0; py < h; py++) {
    const y = originY + (py + 0.5) / scale;
    const xs: number[] = [];
    for (const c of contours) {
      for (let i = 0; i < c.length; i++) {
        const a = c[i];
        const b = c[(i + 1) % c.length];
        if (a.y === b.y) continue;
        const lo = a.y < b.y ? a : b;
        const hi = a.y < b.y ? b : a;
        if (y < lo.y || y >= hi.y) continue;
        xs.push(lo.x + ((y - lo.y) / (hi.y - lo.y)) * (hi.x - lo.x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.ceil((xs[k] - originX) * scale - 0.5);
      const to = Math.floor((xs[k + 1] - originX) * scale - 0.5);
      for (let px = Math.max(0, from); px <= Math.min(w - 1, to); px++) inside[py * w + px] = 1;
    }
  }
  return { w, h, inside, originX, originY, scale };
}

/** Chamfer distance transform: for every interior pixel, the approximate
 * distance to the nearest background pixel. Along the skeleton that distance is
 * half the stroke's width, which is where each column's width comes from. */
function distanceTransform(r: Raster): Float32Array {
  const { w, h, inside } = r;
  const d = new Float32Array(w * h);
  const BIG = 1e9;
  const A = 1;
  const B = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? BIG : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) best = Math.min(best, d[i - w] + A);
      if (x > 0) best = Math.min(best, d[i - 1] + A);
      if (y > 0 && x > 0) best = Math.min(best, d[i - w - 1] + B);
      if (y > 0 && x < w - 1) best = Math.min(best, d[i - w + 1] + B);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < h - 1) best = Math.min(best, d[i + w] + A);
      if (x < w - 1) best = Math.min(best, d[i + 1] + A);
      if (y < h - 1 && x < w - 1) best = Math.min(best, d[i + w + 1] + B);
      if (y < h - 1 && x > 0) best = Math.min(best, d[i + w - 1] + B);
      d[i] = best;
    }
  }
  return d;
}

/** Zhang-Suen thinning: erodes the filled shape down to a one-pixel-wide
 * skeleton that keeps the shape's connectivity, so branches and junctions land
 * where the letter's strokes actually meet. */
function thin(r: Raster): Uint8Array {
  const { w, h } = r;
  const img = Uint8Array.from(r.inside);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  let changed = true;
  let guard = 0;
  const doomed: number[] = [];
  while (changed && guard++ < 200) {
    changed = false;
    for (const step of [0, 1]) {
      doomed.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!at(x, y)) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y),
            p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1),
            p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const bp = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (bp < 2 || bp > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let ap = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) ap++;
          if (ap !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          doomed.push(y * w + x);
        }
      }
      if (doomed.length > 0) {
        for (const i of doomed) img[i] = 0;
        changed = true;
      }
    }
  }
  return img;
}

interface RawBranch {
  pts: Point[];
  a: number; // pixel index of the first end
  b: number; // pixel index of the last end
}

/** Splits the skeleton into branches: each run of pixels between two endpoints
 * or junctions. Those runs are the raw material for the letter's strokes -- but
 * a branch ends at every junction, so a stem crossed by a bar arrives here as
 * two halves and has to be rejoined (see mergeThroughJunctions). */
function traceBranches(skel: Uint8Array, w: number, h: number): RawBranch[] {
  const idx = (x: number, y: number) => y * w + x;
  const nbrs = (x: number, y: number): number[][] => {
    const out: number[][] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (skel[idx(nx, ny)]) out.push([nx, ny]);
      }
    }
    return out;
  };
  // How many branches actually leave a pixel is its crossing number -- the count
  // of 0-to-1 transitions around its eight neighbours -- not how many neighbours
  // it has. On a diagonal the skeleton runs as a staircase, so an ordinary pixel
  // along it has three neighbours and would be mistaken for a junction. Counting
  // that way chopped every diagonal into a chain of stubs, which is why "X" and
  // "Y" came apart into slivers while upright letters were fine. Its three
  // neighbours are contiguous around the ring, so its crossing number is two and
  // it is correctly seen as an ordinary point on a line.
  const crossing = (x: number, y: number): number => {
    const ring = [
      [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ];
    let count = 0;
    for (let k = 0; k < 8; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % 8];
      const ax = x + a[0], ay = y + a[1];
      const bx = x + b[0], by = y + b[1];
      const av = ax < 0 || ay < 0 || ax >= w || ay >= h ? 0 : skel[idx(ax, ay)];
      const bv = bx < 0 || by < 0 || bx >= w || by >= h ? 0 : skel[idx(bx, by)];
      if (av === 0 && bv === 1) count++;
    }
    return count;
  };
  const degree = new Uint8Array(w * h);
  const pixels: number[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!skel[idx(x, y)]) continue;
      const n = nbrs(x, y).length;
      degree[idx(x, y)] = n <= 1 ? n : crossing(x, y);
      pixels.push([x, y]);
    }
  }

  const usedEdge = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? a + ':' + b : b + ':' + a);
  const branches: RawBranch[] = [];

  const walkFrom = (sx: number, sy: number) => {
    for (const n of nbrs(sx, sy)) {
      const nx = n[0];
      const ny = n[1];
      if (usedEdge.has(edgeKey(idx(sx, sy), idx(nx, ny)))) continue;
      const path: Point[] = [{ x: sx, y: sy }];
      let px = sx;
      let py = sy;
      let cx = nx;
      let cy = ny;
      usedEdge.add(edgeKey(idx(px, py), idx(cx, cy)));
      path.push({ x: cx, y: cy });
      // Follow the chain while each pixel has exactly one way onward.
      while (degree[idx(cx, cy)] === 2) {
        // Drop candidates that touch the pixel we just came from: on a diagonal
        // staircase those are the same step seen sideways, not a way onward.
        const options = nbrs(cx, cy).filter(
          (o) =>
            !(o[0] === px && o[1] === py) &&
            !(Math.abs(o[0] - px) <= 1 && Math.abs(o[1] - py) <= 1),
        );
        if (options.length !== 1) break;
        const ax = options[0][0];
        const ay = options[0][1];
        const key = edgeKey(idx(cx, cy), idx(ax, ay));
        if (usedEdge.has(key)) break;
        usedEdge.add(key);
        px = cx;
        py = cy;
        cx = ax;
        cy = ay;
        path.push({ x: cx, y: cy });
      }
      if (path.length >= 2) branches.push({ pts: path, a: idx(sx, sy), b: idx(cx, cy) });
    }
  };

  // Endpoints and junctions first: those give whole, correctly-terminated
  // strokes. Whatever is left over is a closed loop with no junction at all --
  // an "O" or the bowl of a "b" -- broken open at an arbitrary pixel.
  for (const p of pixels) if (degree[idx(p[0], p[1])] === 1) walkFrom(p[0], p[1]);
  for (const p of pixels) if (degree[idx(p[0], p[1])] >= 3) walkFrom(p[0], p[1]);
  for (const p of pixels) {
    const anyUnused = nbrs(p[0], p[1]).some((n) => !usedEdge.has(edgeKey(idx(p[0], p[1]), idx(n[0], n[1]))));
    if (anyUnused) walkFrom(p[0], p[1]);
  }
  return branches;
}

/** Direction a branch heads in as it leaves the given end, measured a few
 * pixels in so a single stair-stepped pixel does not decide it. */
function endDirection(pts: Point[], fromStart: boolean, lookahead = 6): { x: number; y: number } {
  const a = fromStart ? pts[0] : pts[pts.length - 1];
  const bi = fromStart ? Math.min(lookahead, pts.length - 1) : Math.max(0, pts.length - 1 - lookahead);
  const b = pts[bi];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Rejoins branches that a junction cut in half.
 *
 * Thinning gives a branch per span between junctions, so the stem of an "H" (or
 * either leg of an "A") arrives as two pieces with the crossbar's junction
 * between them. Stitched that way each stem would be two satin columns meeting
 * end-on in the middle, with a visible seam and twice the trims. A digitized
 * font runs one column the whole length of the stem and lays the bar across it.
 *
 * At each junction the incident branch ends are paired up by how nearly they
 * continue each other: a pair whose directions are close to opposite is one
 * stroke passing through, and is merged. Pairs that turn a real corner, and the
 * odd branch left over at a three-way junction, stay separate. Widths have to
 * agree too, so a hairline serif is never welded onto a thick stem. */
function mergeThroughJunctions(branches: RawBranch[], widthOf: (pts: Point[]) => number): RawBranch[] {
  // How straight a pair has to be to count as one stroke passing through:
  // directions leaving the junction pointing within ~40 degrees of opposite.
  const STRAIGHT_DOT = -0.77;
  const WIDTH_RATIO = 1.6;

  const list = branches.map((b) => ({ ...b, pts: [...b.pts] }));

  for (;;) {
    let best: { i: number; j: number; ei: boolean; ej: boolean; dot: number } | null = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const wi = widthOf(list[i].pts);
        const wj = widthOf(list[j].pts);
        const ratio = Math.max(wi, wj) / Math.max(1e-6, Math.min(wi, wj));
        if (ratio > WIDTH_RATIO) continue;
        // Every combination of which end of i meets which end of j.
        for (const ei of [true, false]) {
          for (const ej of [true, false]) {
            const ni = ei ? list[i].a : list[i].b;
            const nj = ej ? list[j].a : list[j].b;
            if (ni !== nj) continue;
            const di = endDirection(list[i].pts, ei);
            const dj = endDirection(list[j].pts, ej);
            const dot = di.x * dj.x + di.y * dj.y;
            if (dot > STRAIGHT_DOT) continue;
            if (!best || dot < best.dot) best = { i, j, ei, ej, dot };
          }
        }
      }
    }
    if (!best) break;

    // Orient both so the shared node ends up in the middle of the join.
    const A = list[best.i];
    const B = list[best.j];
    const aPts = best.ei ? [...A.pts].reverse() : A.pts;
    const aFar = best.ei ? A.b : A.a;
    const bPts = best.ej ? B.pts : [...B.pts].reverse();
    const bFar = best.ej ? B.b : B.a;
    // Drop the duplicated junction pixel where the two meet.
    const joined = [...aPts, ...bPts.slice(1)];
    list.splice(best.j, 1);
    list[best.i] = { pts: joined, a: aFar, b: bFar };
  }
  return list;
}

/** Cuts a stroke where it turns a real corner. A satin column stitched around a
 * sharp bend stretches badly on the outside of the turn and bunches on the
 * inside, so the foot of an "L" or the elbow of a "Z" belongs in its own column
 * meeting the stem at the corner, which is how a digitized font draws it. */
function splitAtCorners(pts: Point[], windowPx: number): Point[][] {
  if (pts.length < windowPx * 2 + 3) return [pts];
  const TURN_COS = Math.cos((52 * Math.PI) / 180);
  const cuts: number[] = [];
  let lastCut = 0;
  for (let i = windowPx; i < pts.length - windowPx; i++) {
    const a = pts[i - windowPx];
    const b = pts[i];
    const c = pts[i + windowPx];
    const d1x = b.x - a.x, d1y = b.y - a.y;
    const d2x = c.x - b.x, d2y = c.y - b.y;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const l2 = Math.hypot(d2x, d2y) || 1;
    const dot = (d1x * d2x + d1y * d2y) / (l1 * l2);
    if (dot < TURN_COS && i - lastCut > windowPx) {
      cuts.push(i);
      lastCut = i;
    }
  }
  if (cuts.length === 0) return [pts];
  const segs: Point[][] = [];
  let from = 0;
  for (const cut of cuts) {
    segs.push(pts.slice(from, cut + 1));
    from = cut;
  }
  segs.push(pts.slice(from));
  return segs.filter((sg) => sg.length >= 2);
}

function smooth(path: Point[], passes: number): Point[] {
  let out = path;
  for (let k = 0; k < passes; k++) {
    const next: Point[] = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      next.push({
        x: (out[i - 1].x + out[i].x * 2 + out[i + 1].x) / 4,
        y: (out[i - 1].y + out[i].y * 2 + out[i + 1].y) / 4,
      });
    }
    if (out.length > 1) next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function resampleEvery(path: Point[], step: number): Point[] {
  if (path.length < 2) return path;
  const out: Point[] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let pos = 0;
    while (acc + (seg - pos) >= step) {
      pos += step - acc;
      const t = pos / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      acc = 0;
    }
    acc += seg - pos;
  }
  const last = path[path.length - 1];
  if (Math.hypot(last.x - out[out.length - 1].x, last.y - out[out.length - 1].y) > 1e-6) out.push(last);
  return out;
}

/** Pushes a stroke's two ends outward along their own direction until they
 * reach the edge of the glyph. Thinning stops roughly half a stroke-width short
 * of the real end of a stroke, so without this every stem of a letter would be
 * stitched visibly short at top and bottom. */
function extendToEdge(path: Point[], r: Raster, maxMm: number): Point[] {
  const insideAt = (p: Point): boolean => {
    const px = Math.round((p.x - r.originX) * r.scale - 0.5);
    const py = Math.round((p.y - r.originY) * r.scale - 0.5);
    if (px < 0 || py < 0 || px >= r.w || py >= r.h) return false;
    return r.inside[py * r.w + px] === 1;
  };
  const push = (from: Point, toward: Point): Point => {
    const dx = from.x - toward.x;
    const dy = from.y - toward.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return from;
    const ux = dx / len;
    const uy = dy / len;
    let best = from;
    const stepMm = 1 / r.scale;
    for (let d = stepMm; d <= maxMm; d += stepMm) {
      const cand = { x: from.x + ux * d, y: from.y + uy * d };
      if (!insideAt(cand)) break;
      best = cand;
    }
    return best;
  };
  if (path.length < 2) return path;
  const head = push(path[0], path[Math.min(2, path.length - 1)]);
  const tail = push(path[path.length - 1], path[Math.max(0, path.length - 3)]);
  return [head, ...path.slice(1, -1), tail];
}

/** How much of the glyph the proposed columns would actually cover.
 *
 * A satin column is a constant-width band down a centreline, and a letter is
 * not: strokes taper, ends are cut flat, corners stick out past any band drawn
 * through them. Where the two disagree the result is bare fabric, which is far
 * worse than stitching the letter as a plain fill. So the columns are painted
 * back into a grid the same size as the glyph and compared against it, and the
 * caller uses that to decide whether the stroke decomposition is trustworthy
 * for this particular glyph. */
function coverageOf(strokes: Stroke[], r: Raster, extraMm: number): number {
  const painted = new Uint8Array(r.w * r.h);
  for (const st of strokes) {
    for (let i = 1; i < st.centerline.length; i++) {
      // Include the pull compensation the column will really be stitched with:
      // the rails sit a little proud of the outline on purpose, and judging
      // coverage without it understates what actually lands on the fabric.
      const half = ((st.halfWidths[i - 1] + st.halfWidths[i]) / 2 + extraMm) * r.scale;
      const a = st.centerline[i - 1];
      const b = st.centerline[i];
      const ax = (a.x - r.originX) * r.scale;
      const ay = (a.y - r.originY) * r.scale;
      const bx = (b.x - r.originX) * r.scale;
      const by = (b.y - r.originY) * r.scale;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        const lo = Math.max(0, Math.floor(cy - half));
        const hi = Math.min(r.h - 1, Math.ceil(cy + half));
        for (let py = lo; py <= hi; py++) {
          const dy = py - cy;
          const span = Math.sqrt(Math.max(0, half * half - dy * dy));
          const x0 = Math.max(0, Math.floor(cx - span));
          const x1 = Math.min(r.w - 1, Math.ceil(cx + span));
          for (let px = x0; px <= x1; px++) painted[py * r.w + px] = 1;
        }
      }
    }
  }
  let total = 0;
  let hit = 0;
  for (let i = 0; i < painted.length; i++) {
    if (!r.inside[i]) continue;
    total++;
    if (painted[i]) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

/** Breaks one glyph island into the satin strokes a digitized font would use.
 * Returns null when the shape is not stroke-like at all (a solid blob, or too
 * small to raster meaningfully) -- the caller then falls back to a plain fill.
 *
 * `contours` is the island's outer boundary followed by any holes, already
 * flattened to polylines in design millimetres. */
export function glyphToStrokes(
  contours: Point[][],
  pullCompensationMm = 0.12,
): { strokes: Stroke[]; coverage: number } | null {
  if (contours.length === 0 || contours[0].length < 3) return null;
  const r = rasterize(contours, 3);
  if (!r) return null;

  const dist = distanceTransform(r);
  const skel = thin(r);

  const pxToMm = (p: Point): Point => ({
    x: r.originX + (p.x + 0.5) / r.scale,
    y: r.originY + (p.y + 0.5) / r.scale,
  });
  const halfWidthAt = (p: Point): number => {
    const i = Math.round(p.y) * r.w + Math.round(p.x);
    return i >= 0 && i < dist.length ? dist[i] / r.scale : 0;
  };

  const raw = traceBranches(skel, r.w, r.h);
  if (raw.length === 0) return null;

  // Width is measured over the middle of a branch only. Right at a junction the
  // shape bulges -- the crossing of an "X" has material from both diagonals
  // around it -- so the distance transform there reports a stroke far thicker
  // than the stroke really is, and including those samples drags the median off.
  const widthOf = (pts: Point[]): number => {
    const from = Math.floor(pts.length * 0.2);
    const to = Math.ceil(pts.length * 0.8);
    const core = pts.slice(from, Math.max(from + 1, to));
    const halves = core.map(halfWidthAt).sort((a, b) => a - b);
    return halves[Math.floor(halves.length / 2)] * 2;
  };

  // Thinning leaves short whiskers where strokes meet, especially at a shallow
  // crossing. Left in, they take part in the junction pairing and stop the two
  // real diagonals of an "X" or "K" from being recognised as continuing through
  // each other. A whisker has one loose end and is shorter than it is wide.
  const degreeAt = new Map<number, number>();
  for (const br of raw) {
    degreeAt.set(br.a, (degreeAt.get(br.a) ?? 0) + 1);
    degreeAt.set(br.b, (degreeAt.get(br.b) ?? 0) + 1);
  }
  const pruned = raw.filter((br) => {
    const loose = (degreeAt.get(br.a) ?? 0) === 1 || (degreeAt.get(br.b) ?? 0) === 1;
    if (!loose) return true;
    let len = 0;
    for (let i = 1; i < br.pts.length; i++) {
      len += Math.hypot(br.pts[i].x - br.pts[i - 1].x, br.pts[i].y - br.pts[i - 1].y);
    }
    return len / r.scale >= widthOf(br.pts) * 0.9;
  });
  const seed = pruned.length > 0 ? pruned : raw;

  // Rejoin what the junctions cut apart, then cut again only where the stroke
  // genuinely turns a corner.
  const merged = mergeThroughJunctions(seed, widthOf);
  const pieces: Point[][] = [];
  for (const br of merged) {
    const cornerWindow = Math.max(3, Math.round(widthOf(br.pts) * r.scale * 0.7));
    for (const seg of splitAtCorners(br.pts, cornerWindow)) pieces.push(seg);
  }

  const strokes: Stroke[] = [];
  for (const piece of pieces) {
    const width = widthOf(piece);
    if (width < 0.25) continue;

    let mm = piece.map(pxToMm);
    let length = 0;
    for (let i = 1; i < mm.length; i++) length += Math.hypot(mm[i].x - mm[i - 1].x, mm[i].y - mm[i - 1].y);
    // Spurs: thinning throws these off at corners and serifs. They are short
    // relative to how thick they claim to be, which is what separates them from
    // a genuine short stroke like the crossbar of a "t".
    if (length < width * SPUR_FACTOR) continue;

    mm = smooth(mm, 3);
    mm = resampleEvery(mm, Math.max(0.35, width * 0.6));
    if (mm.length < 2) continue;
    mm = extendToEdge(mm, r, width * 0.75);

    // How far the letter actually extends either side of each point. Taken from
    // the distance transform, so the column inscribes the stroke rather than
    // approximating it: it reaches the edge where the stroke is full width and
    // pulls in where it tapers or ends.
    const halfWidths = mm.map((p) => {
      const px = (p.x - r.originX) * r.scale - 0.5;
      const py = (p.y - r.originY) * r.scale - 0.5;
      const i = Math.round(py) * r.w + Math.round(px);
      const d = i >= 0 && i < dist.length ? dist[i] / r.scale : 0;
      return Math.max(0.1, d);
    });
    // A single stray sample (right at a junction, or one pixel outside at an
    // extended end) would put a notch in the column's edge; a light smoothing
    // keeps the rail continuous without losing the taper.
    const smoothedHalf = halfWidths.map((_, i) => {
      const a = halfWidths[Math.max(0, i - 1)];
      const b = halfWidths[i];
      const c = halfWidths[Math.min(halfWidths.length - 1, i + 1)];
      return (a + b * 2 + c) / 4;
    });

    // Square off the two ends. Distance to the boundary necessarily falls to
    // nothing at the tip of a stroke, so a column that follows it tapers to a
    // point -- but a letter's stroke is cut off square, and the corners either
    // side of that flat end are then left bare. On a plain stem like "l" or "i"
    // that alone was most of the missing coverage. Hold the width from one
    // half-width in, out to the end, so the column finishes with a flat edge the
    // same shape as the letter's own.
    const holdFrom = (fromStart: boolean) => {
      const n = smoothedHalf.length;
      const endIdx = fromStart ? 0 : n - 1;
      const target = smoothedHalf[endIdx];
      let walked = 0;
      for (let k = 1; k < n; k++) {
        const i = fromStart ? k : n - 1 - k;
        const j = fromStart ? k - 1 : n - k;
        walked += Math.hypot(mm[i].x - mm[j].x, mm[i].y - mm[j].y);
        if (walked >= Math.max(target, smoothedHalf[i])) {
          for (let q = 0; q < k; q++) {
            const idx = fromStart ? q : n - 1 - q;
            smoothedHalf[idx] = Math.max(smoothedHalf[idx], smoothedHalf[i]);
          }
          return;
        }
      }
    };
    holdFrom(true);
    holdFrom(false);

    strokes.push({ centerline: mm, width, halfWidths: smoothedHalf });
  }

  if (strokes.length === 0) return null;
  return { strokes, coverage: coverageOf(strokes, r, pullCompensationMm) };
}
