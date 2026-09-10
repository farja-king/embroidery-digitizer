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
 * Coordinates are normalised to an em square: x from the glyph's left edge, y
 * from the baseline (negative upward, matching the app's screen convention),
 * both divided by the em. Multiply by the point size in millimetres to place. */
export interface EmbroideryFont {
  name: string;
  capHeight: number;
  spaceAdvance: number;
  glyphs: Record<string, { adv: number; cols: { a: number[][]; b: number[][] }[] }>;
}

export const BUILT_IN_FONT = alphabet as EmbroideryFont;

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
  sizeMm: number; // em square, same convention as a point size
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
  const objects: EmbObject[] = [];
  let penX = x;

  for (const ch of text) {
    if (ch === ' ') {
      penX += font.spaceAdvance * sizeMm + spacing;
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
        points.push({ x: penX + gx * sizeMm, y: y + gy * sizeMm, type: 'corner' });
      }
      railSplits.push(points.length - startOfColumn);
      for (const [gx, gy] of col.b) {
        points.push({ x: penX + gx * sizeMm, y: y + gy * sizeMm, type: 'corner' });
      }
    }
    penX += glyph.adv * sizeMm + spacing;
    if (points.length < 4) continue;

    const obj = defaultObject('satin', points, color);
    obj.satin.columnBreaks = columnBreaks;
    obj.satin.railSplits = railSplits;
    // Nominal width, for the properties panel and for anything that asks
    // without looking at the rails. The rails are what actually gets stitched.
    obj.satin.width = columnWidth(glyph.cols[0], sizeMm);
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

function columnWidth(col: { a: number[][]; b: number[][] } | undefined, sizeMm: number): number {
  if (!col || col.a.length === 0 || col.b.length === 0) return 1;
  const mid = Math.floor(Math.min(col.a.length, col.b.length) / 2);
  const a = col.a[mid];
  const b = col.b[mid];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) * sizeMm;
}
