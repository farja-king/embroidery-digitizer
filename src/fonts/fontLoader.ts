import opentype from 'opentype.js';

// The Local Font Access API (window.queryLocalFonts) isn't in TypeScript's DOM
// lib yet -- it's a real, shipping Chrome/Edge API (permission-gated, HTTPS or
// localhost only), just not one TS ships types for. Minimal shape of what we
// actually use.
interface LocalFontData {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}
declare global {
  interface Window {
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;
  }
}

export interface FontEntry {
  key: string; // stable id -- postscriptName for local fonts, a generated one for uploads
  displayName: string; // "Family Style", e.g. "Arial Bold"
  source: 'local' | 'upload';
  // Lazily parsed and cached -- a system font list can be in the hundreds; only
  // actually fetch + parse the bytes for a font once the user picks it.
  load: () => Promise<opentype.Font>;
}

const parsedCache = new Map<string, opentype.Font>();

/** True only where the Local Font Access API actually exists -- Chrome/Edge on a
 * secure origin (HTTPS or localhost). Firefox/Safari never have it; check this
 * before offering the "load system fonts" button instead of letting the call
 * throw and showing a confusing error. */
export function supportsLocalFontAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/** Triggers the browser's local-font permission prompt (must be called from a
 * real user gesture -- a click handler, not on page load) and returns every
 * installed font as a lazily-loadable FontEntry, including fonts the user has
 * sideloaded/installed themselves -- the OS font list, not a curated web-font
 * set. Throws if the user denies the permission or the browser doesn't support
 * it; callers should catch and fall back to manual upload. */
export async function requestLocalFonts(): Promise<FontEntry[]> {
  if (!window.queryLocalFonts) {
    throw new Error('This browser does not support automatic system font detection (Chrome or Edge required). Upload a font file instead.');
  }
  const fonts = await window.queryLocalFonts();
  // A family with multiple styles (Regular/Bold/Italic/...) lists one FontData
  // per style -- keep them all, distinguished in the label, so e.g. "Arial Bold"
  // is a separate pickable entry from "Arial".
  return fonts.map((f) => ({
    key: f.postscriptName,
    displayName: f.style && f.style !== 'Regular' ? `${f.family} ${f.style}` : f.family,
    source: 'local' as const,
    load: () => loadCached(f.postscriptName, async () => {
      const blob = await f.blob();
      return opentype.parse(await blob.arrayBuffer());
    }),
  }));
}

/** Parses a user-uploaded .ttf/.otf/.woff file (via a <input type="file"> or
 * drag-drop) into a FontEntry with the same shape as a local font, so the rest
 * of the text tool doesn't need to care where a font came from. */
export async function loadUploadedFont(file: File): Promise<FontEntry> {
  const buf = await file.arrayBuffer();
  const font = opentype.parse(buf);
  const key = `upload:${file.name}:${file.size}`;
  parsedCache.set(key, font);
  const family = font.names.fontFamily?.en ?? file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
  const style = font.names.fontSubfamily?.en ?? '';
  return {
    key,
    displayName: style && style !== 'Regular' ? `${family} ${style}` : family,
    source: 'upload',
    load: async () => font,
  };
}

async function loadCached(key: string, fetcher: () => Promise<opentype.Font>): Promise<opentype.Font> {
  const cached = parsedCache.get(key);
  if (cached) return cached;
  const font = await fetcher();
  parsedCache.set(key, font);
  return font;
}
