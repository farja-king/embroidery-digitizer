import alphabet from './fonts/alphabet.json';
import { defaultObject, makeId } from '../state/store';
import type { EmbObject, PathPoint, RGB, UnderlaySettings } from '../types';

/** A digitized embroidery font: for every character, the satin columns it is
 * built from, each given as its two rails in the order the original was sewn.
 *
 * This is what a lettering font in embroidery software actually is, and it is
 * why letters from one look right. Deriving columns from a TrueType outline
 * instead -- skeletonising the shape and guessing where the strokes are -- gets
 * the structure roughly right and the detail wrong, which is visible on every
 * curve and every junction. Here nothing is guessed: the rails came out of a
 * stitched alphabet chart, so a letter set from this font is the same letter
 * the chart was sewn with.
 *
 * Coordinates are normalised: x from the glyph's left edge, y from the baseline
 * (negative upward, matching the app's screen convention). Multiply by
 * `scaleFor(font, sizeMm)` to place them. */
export interface EmbroideryFont {
  name: string;
  capHeight: number;
  spaceAdvance: number;
  glyphs: Record<string, { adv: number; cols: { a: number[][]; b: number[][] }[] }>;
}

export const BUILT_IN_FONT = alphabet as EmbroideryFont;

// Which glyphs are flat-topped capitals sitting squarely on the baseline, with
// no overshoot -- the ones whose height is the cap height by definition.
const CAP_SAMPLES = 'EFHILT';

/** The height of a capital, in the font's own normalised units, measured from
 * the stored geometry rather than taken on trust from the header. */
function measuredCapHeight(font: EmbroideryFont): number {
  const heights: number[] = [];
  for (const ch of CAP_SAMPLES) {
    const g = font.glyphs[ch];
    if (!g) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const col of g.cols) {
      for (const [, y] of [...col.a, ...col.b]) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
    if (isFinite(lo)) heights.push(hi - lo);
  }
  if (heights.length === 0) return font.capHeight || 0.716;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

const capCache = new WeakMap<EmbroideryFont, number>();

/** Millimetres per normalised unit for a requested size.
 *
 * The size of lettering means the height of a capital -- that is what it means
 * on a machine, in a catalogue and in Hatch, and it is the only figure anyone
 * can check with a ruler. Treating the number as an em square instead, the way
 * a word processor does, quietly produces letters about a third shorter than
 * the number says. */
export function scaleFor(font: EmbroideryFont, sizeMm: number): number {
  let cap = capCache.get(font);
  if (cap === undefined) {
    cap = measuredCapHeight(font);
    capCache.set(font, cap);
  }
  return sizeMm / cap;
}

export function hasGlyph(font: EmbroideryFont, ch: string): boolean {
  return ch === ' ' || Object.prototype.hasOwnProperty.call(font.glyphs, ch);
}

/** Which characters of `text` this font cannot set. */
export function missingGlyphs(font: EmbroideryFont, text: string): string[] {
  return [...new Set([...text].filter((c) => !hasGlyph(font, c)))];
}

export interface EmbroideryTextOptions {
  text: string;
  font: EmbroideryFont;
  sizeMm: number; // height of a capital, the way lettering size is always given
  x: number; // design mm, baseline start
  y: number; // design mm, baseline
  color: RGB;
  letterSpacingMm?: number;
  underlayMode?: 'auto' | 'none';
}

/** Lays out a string and returns one object per character.
 *
 * One object per character, not one per stroke: a letter is a single thing to
 * select and move, and its strokes are stitched in one continuous run with the
 * machine walking between them instead of trimming. Both rails of every column
 * live in the object's own points, so moving, scaling and rotating the letter
 * carries them with it. */
export function embroideryTextToObjects(opts: EmbroideryTextOptions): EmbObject[] {
  const { text, font, sizeMm, x, y, color } = opts;
  const spacing = opts.letterSpacingMm ?? 0;
  const scale = scaleFor(font, sizeMm);
  const objects: EmbObject[] = [];
  let penX = x;

  for (const ch of text) {
    if (ch === ' ') {
      penX += font.spaceAdvance * scale + spacing;
      continue;
    }
    const glyph = font.glyphs[ch];
    if (!glyph) continue;

    const points: PathPoint[] = [];
    const columnBreaks: number[] = [];
    const railSplits: number[] = [];

    for (const col of glyph.cols) {
      if (col.a.length < 2 || col.b.length < 2) continue;
      if (points.length > 0) columnBreaks.push(points.length);
      const startOfColumn = points.length;
      for (const [gx, gy] of col.a) {
        points.push({ x: penX + gx * scale, y: y + gy * scale, type: 'corner' });
      }
      railSplits.push(points.length - startOfColumn);
      for (const [gx, gy] of col.b) {
        points.push({ x: penX + gx * scale, y: y + gy * scale, type: 'corner' });
      }
    }
    penX += glyph.adv * scale + spacing;
    if (points.length < 4) continue;

    const obj = defaultObject('satin', points, color);
    obj.satin.columnBreaks = columnBreaks;
    obj.satin.railSplits = railSplits;
    // Nominal width, for the properties panel and for anything that asks
    // without looking at the rails. The rails are what actually gets stitched.
    obj.satin.width = columnWidth(glyph.cols[0], scale);
    obj.satin.pullCompensation = 0;
    obj.id = makeId();
    obj.name = `${ch} — "${text}"`;
    obj.fromText = true;
    if (opts.underlayMode === 'none') {
      const none: UnderlaySettings = { mode: 'manual', type: 'none', spacing: 2.5 };
      obj.satin.underlay = { pass1: none, pass2: none };
    }
    objects.push(obj);
  }
  return objects;
}

function columnWidth(col: { a: number[][]; b: number[][] } | undefined, scale: number): number {
  if (!col || col.a.length === 0 || col.b.length === 0) return 1;
  const mid = Math.floor(Math.min(col.a.length, col.b.length) / 2);
  const a = col.a[mid];
  const b = col.b[mid];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) * scale;
}
