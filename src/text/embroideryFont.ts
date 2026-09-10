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

/** Builds the geometry for one word: every column of every letter, end to end,
 * with the break indices that say where each column starts and where its second
 * rail begins. */
function buildWord(
  word: string,
  font: EmbroideryFont,
  sizeMm: number,
  letterSpacingMm: number,
  originX: number,
  originY: number,
): { points: PathPoint[]; columnBreaks: number[]; railSplits: number[]; letterBreaks: number[]; width: number } | null {
  const scale = scaleFor(font, sizeMm);
  const points: PathPoint[] = [];
  const columnBreaks: number[] = [];
  const railSplits: number[] = [];
  const letterBreaks: number[] = [];
  let penX = originX;
  let firstWidth = 0;

  for (const ch of word) {
    const glyph = font.glyphs[ch];
    if (!glyph) continue;
    letterBreaks.push(railSplits.length);
    for (const col of glyph.cols) {
      if (col.a.length < 2 || col.b.length < 2) continue;
      if (points.length > 0) columnBreaks.push(points.length);
      const startOfColumn = points.length;
      for (const [gx, gy] of col.a) {
        points.push({ x: penX + gx * scale, y: originY + gy * scale, type: 'corner' });
      }
      railSplits.push(points.length - startOfColumn);
      for (const [gx, gy] of col.b) {
        points.push({ x: penX + gx * scale, y: originY + gy * scale, type: 'corner' });
      }
      if (firstWidth === 0) firstWidth = columnWidth(col, scale);
    }
    penX += glyph.adv * scale + letterSpacingMm;
  }
  if (points.length < 4) return null;
  return { points, columnBreaks, railSplits, letterBreaks, width: firstWidth || 1 };
}

/** How wide a word will be, so the caller can advance the pen without building
 * the geometry twice. */
function wordWidth(word: string, font: EmbroideryFont, sizeMm: number, letterSpacingMm: number): number {
  const scale = scaleFor(font, sizeMm);
  let w = 0;
  for (const ch of word) {
    const glyph = font.glyphs[ch];
    if (!glyph) continue;
    w += glyph.adv * scale + letterSpacingMm;
  }
  return w;
}

/** Rebuilds a text object's stitches from what was typed.
 *
 * The object remembers the wording, the size and the letter spacing, not just
 * the geometry those produced, so any of them can be changed afterwards and
 * the word redrawn -- the way a text box behaves in a drawing program. */
export function rebuildTextObject(obj: EmbObject, patch: Partial<NonNullable<EmbObject['text']>> = {}): EmbObject {
  const meta = { ...obj.text!, ...patch };
  const built = buildWord(meta.value, BUILT_IN_FONT, meta.sizeMm, meta.letterSpacingMm, meta.originX, meta.originY);
  if (!built) return { ...obj, text: meta };
  return {
    ...obj,
    name: `"${meta.value}"`,
    points: built.points,
    text: meta,
    satin: {
      ...obj.satin,
      columnBreaks: built.columnBreaks,
      railSplits: built.railSplits,
      letterBreaks: built.letterBreaks,
      width: built.width,
    },
  };
}

/** Lays out a string and returns one object per word.
 *
 * A word, not a letter and not a whole line. One object per word means the
 * word is a single thing to select and to set stitch settings on, and -- the
 * reason it matters on the machine -- its letters are sewn in one continuous
 * run with the needle walking between them. As separate objects the thread had
 * to jump from wherever one letter happened to finish to wherever the next
 * happened to start, and any jump past the trim threshold makes the machine cut
 * and re-thread. On a test stitch-out that was five cuts in two words. */
export function embroideryTextToObjects(opts: EmbroideryTextOptions): EmbObject[] {
  const { text, font, sizeMm, x, y, color } = opts;
  const spacing = opts.letterSpacingMm ?? 0;
  const scale = scaleFor(font, sizeMm);
  const objects: EmbObject[] = [];
  let penX = x;

  for (const word of text.split(/(\s+)/)) {
    if (word.length === 0) continue;
    if (/^\s+$/.test(word)) {
      penX += word.length * font.spaceAdvance * scale;
      continue;
    }
    const built = buildWord(word, font, sizeMm, spacing, penX, y);
    penX += wordWidth(word, font, sizeMm, spacing);
    if (!built) continue;

    const obj = defaultObject('satin', built.points, color);
    obj.satin.columnBreaks = built.columnBreaks;
    obj.satin.railSplits = built.railSplits;
    obj.satin.letterBreaks = built.letterBreaks;
    obj.satin.width = built.width;
    obj.satin.pullCompensation = 0;
    obj.id = makeId();
    obj.name = `"${word}"`;
    obj.fromText = true;
    obj.text = { value: word, sizeMm, letterSpacingMm: spacing, originX: penX - wordWidth(word, font, sizeMm, spacing), originY: y };
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
