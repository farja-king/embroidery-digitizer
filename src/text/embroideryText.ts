import { defaultObject, makeId } from '../state/store';
import { BUILT_IN_FONT, buildWord, scaleFor, wordWidth } from './embroideryFont';
import type { EmbroideryFont } from './embroideryFont';
import type { EmbObject, RGB, UnderlaySettings } from '../types';

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
    obj.text = {
      value: word,
      sizeMm,
      letterSpacingMm: spacing,
      originX: penX - wordWidth(word, font, sizeMm, spacing),
      originY: y,
      fontVersion: BUILT_IN_FONT.version,
    };
    if (opts.underlayMode === 'none') {
      const none: UnderlaySettings = { mode: 'manual', type: 'none', spacing: 2.5 };
      obj.satin.underlay = { pass1: none, pass2: none };
    }
    objects.push(obj);
  }
  return objects;
}

