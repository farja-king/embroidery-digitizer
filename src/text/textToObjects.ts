import type * as opentype from 'opentype.js';
import { dist, pointInPolygon, polygonArea } from '../stitching/geometry';
import { defaultObject, makeId } from '../state/store';
import { ribbonToSatin, ringToSatin } from './letterToSatin';
import type { EmbObject, PathPoint, Point, RGB, UnderlaySettings } from '../types';

const CURVE_SEGMENTS = 8; // per bezier curve -- plenty smooth at typical lettering sizes

/** Flattens one opentype.Path (already scaled + positioned in design-space mm)
 * into closed-contour point lists. A glyph's path can contain more than one
 * M...Z run -- an outer stroke plus one or more holes ("O", "A", "B", ...), or
 * entirely separate islands (the dot of "i", the two halves of "%"). */
function pathToContours(path: opentype.Path): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] = [];
  let start: Point = { x: 0, y: 0 };
  let cursor: Point = { x: 0, y: 0 };

  const pushCurve = (points: Point[]) => {
    for (const p of points) current.push(p);
  };
  const cubic = (p0: Point, p1: Point, p2: Point, p3: Point): Point[] => {
    const out: Point[] = [];
    for (let i = 1; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      out.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
      });
    }
    return out;
  };
  const quad = (p0: Point, p1: Point, p2: Point): Point[] => {
    const out: Point[] = [];
    for (let i = 1; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
        y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
      });
    }
    return out;
  };

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        if (current.length > 1) contours.push(current);
        current = [{ x: cmd.x, y: cmd.y }];
        start = { x: cmd.x, y: cmd.y };
        cursor = start;
        break;
      case 'L':
        current.push({ x: cmd.x, y: cmd.y });
        cursor = { x: cmd.x, y: cmd.y };
        break;
      case 'C':
        pushCurve(cubic(cursor, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, { x: cmd.x, y: cmd.y }));
        cursor = { x: cmd.x, y: cmd.y };
        break;
      case 'Q':
        pushCurve(quad(cursor, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }));
        cursor = { x: cmd.x, y: cmd.y };
        break;
      case 'Z':
        if (current.length > 1) contours.push(current);
        current = [];
        cursor = start;
        break;
    }
  }
  if (current.length > 1) contours.push(current);
  return contours;
}

/** Finds the pair of points (one per contour) that are closest together, for
 * splicing a hole into its containing outer with the shortest possible
 * zero-width slit. Fine at lettering scale -- contours are a few hundred points
 * at most. */
function nearestPair(a: Point[], b: Point[]): { ai: number; bi: number } {
  let best = { ai: 0, bi: 0, d: Infinity };
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = dist(a[i], b[j]);
      if (d < best.d) best = { ai: i, bi: j, d };
    }
  }
  return best;
}

/** Merges a hole contour into its containing outer contour via a "keyhole"
 * slit: walk out from the outer's nearest point to the hole, trace the entire
 * hole, walk back to the same point, then continue the outer -- producing one
 * simple (self-touching, never self-crossing) polygon with a zero-width seam.
 * This lets a glyph like "O" or "A" work as a single ordinary Fill object with
 * no changes anywhere in the stitch engine, which only ever deals in single
 * closed polygons. */
function spliceHole(outer: Point[], hole: Point[]): Point[] {
  const { ai, bi } = nearestPair(outer, hole);
  const holeRotated = [...hole.slice(bi), ...hole.slice(0, bi), hole[bi]];
  return [...outer.slice(0, ai + 1), ...holeRotated, ...outer.slice(ai)];
}

interface ContourIsland {
  outer: Point[];
  holes: Point[][];
}

/** Groups a glyph's raw contours into islands -- an outer boundary plus
 * whichever holes fall inside it (a letter can have more than one island, e.g.
 * "%" or "i"'s separate dot). This is the shared first step for both the fill
 * path (splice every hole into its outer) and the satin path (a hole-free
 * island tries as a ribbon; an island with exactly one hole tries as a ring). */
function groupContours(contours: Point[][]): ContourIsland[] {
  if (contours.length === 0) return [];
  if (contours.length === 1) return [{ outer: contours[0], holes: [] }];

  const withArea = contours.map((c) => ({ points: c, area: polygonArea(c) }));
  // TrueType/OpenType winding convention: within one glyph, holes wind opposite
  // to the outer contour(s) that contain them. Split by sign of the signed area
  // rather than trusting which sign means "outer" globally (fonts/rasterizers
  // aren't all consistent about that) -- whichever sign the *largest* contour
  // has is treated as "outer".
  const majoritySign = Math.sign(withArea.reduce((best, c) => (Math.abs(c.area) > Math.abs(best.area) ? c : best)).area);
  const outers = withArea.filter((c) => Math.sign(c.area) === majoritySign || c.area === 0).map((c) => c.points);
  const holes = withArea.filter((c) => Math.sign(c.area) !== majoritySign && c.area !== 0).map((c) => c.points);

  const islands: ContourIsland[] = outers.map((o) => ({ outer: o, holes: [] }));
  for (const hole of holes) {
    // Which outer island actually contains this hole -- matters once a glyph
    // has more than one outer part (e.g. "%").
    const targetIndex = islands.findIndex((isl) => pointInPolygon(hole[0], isl.outer));
    islands[targetIndex === -1 ? 0 : targetIndex].holes.push(hole);
  }
  return islands;
}

/** Splices every hole of an island into its outer, producing one simple
 * hole-free polygon for a plain Fill object -- the fallback path whenever
 * satin conversion isn't attempted or doesn't hold up as a clean stroke. */
function islandToFillPolygon(island: ContourIsland): Point[] {
  return island.holes.reduce((outer, hole) => spliceHole(outer, hole), island.outer);
}

/** A rough per-glyph stitch-angle heuristic: fill rows run along whichever axis
 * the glyph is narrower on, so stitches cross the letter's shorter dimension --
 * the same instinct a digitizer applies by hand (e.g. a tall narrow "I" or "l"
 * fills with horizontal rows, a wide flat dash or underscore fills with
 * vertical ones). Not stroke-following satin (see the text-tool's own
 * explanation of that tradeoff) -- just a better default than always 0°. */
function estimateAngle(points: Point[]): number {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return h > w * 1.3 ? 90 : 0;
}

export interface TextLayoutOptions {
  text: string;
  font: opentype.Font;
  sizeMm: number; // em-square height in mm, same convention as point size but metric
  x: number; // design-space mm, baseline start
  y: number; // design-space mm, baseline
  color: RGB;
  letterSpacingMm?: number; // extra gap added after each glyph's own advance width
  // 'satin-auto' (default) tries a satin column for every simple, non-branching
  // stroke (most letters, or islands within one -- the round part of an "a" and
  // its stem can each satin even if handled independently) and only falls back
  // to a fill polygon where the shape genuinely can't be read as one clean
  // stroke (branching letters like "A"/"E"/"T", or multi-hole islands). 'fill'
  // skips satin entirely -- appropriate for some designs regardless of letter
  // shape, per the user's own call.
  stitchStyle?: 'satin-auto' | 'fill';
  // Applied to pass 1 of whichever kind each resulting object ends up being
  // (satin or fill) -- same underlay choice available to every other element,
  // set once for the whole string instead of per letter.
  underlayMode?: 'auto' | 'none';
}

function applyUnderlayMode(obj: EmbObject, mode: 'auto' | 'none' | undefined): void {
  if (mode !== 'none') return; // 'auto' is defaultObject()'s own default already
  const none: UnderlaySettings = { mode: 'manual', type: 'none', spacing: 2.5 };
  if (obj.kind === 'satin') obj.satin.underlay = { pass1: none, pass2: none };
  else obj.fill.underlay = { pass1: none, pass2: none };
}

/** Lays out a string with the given font at the given size/position and returns
 * one EmbObject per glyph island (a glyph is usually one object; a glyph with
 * disconnected islands like "i" or "%" becomes more than one) -- satin where
 * the island reads as a clean single stroke, fill otherwise. Uses the font's
 * own glyph outlines and kerning table via opentype.js -- real digitized
 * shapes, not an approximation. */
export function textToObjects(opts: TextLayoutOptions): EmbObject[] {
  const { text, font, sizeMm, x, y, color } = opts;
  const stitchStyle = opts.stitchStyle ?? 'satin-auto';
  const scale = sizeMm / font.unitsPerEm;
  const letterSpacing = opts.letterSpacingMm ?? 0;
  const glyphs = font.stringToGlyphs(text);

  const objects: EmbObject[] = [];
  let cursorX = x;
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    if (i > 0) {
      const kerning = font.getKerningValue(glyphs[i - 1], glyph);
      cursorX += kerning * scale;
    }
    const path = glyph.getPath(cursorX, y, sizeMm);
    const islands = groupContours(pathToContours(path));
    for (const island of islands) {
      if (island.outer.length < 3) continue;

      const satin =
        stitchStyle === 'satin-auto'
          ? island.holes.length === 0
            ? ribbonToSatin(island.outer)
            : island.holes.length === 1
              ? ringToSatin(island.outer, island.holes[0])
              : null
          : null;

      let obj: EmbObject;
      if (satin) {
        const points: PathPoint[] = satin.centerline.map((p) => ({ x: p.x, y: p.y, type: 'corner' }));
        obj = defaultObject('satin', points, color);
        obj.satin.width = satin.width;
      } else {
        const poly = islandToFillPolygon(island);
        if (poly.length < 3) continue;
        const points: PathPoint[] = poly.map((p) => ({ x: p.x, y: p.y, type: 'corner' }));
        obj = defaultObject('fill', points, color);
        obj.fill.angle = estimateAngle(poly);
      }
      obj.id = makeId();
      obj.name = `Text "${text}"`;
      applyUnderlayMode(obj, opts.underlayMode);
      objects.push(obj);
    }
    cursorX += (glyph.advanceWidth ?? 0) * scale + letterSpacing;
  }
  return objects;
}
