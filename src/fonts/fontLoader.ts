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

// The text tool's font list (both system fonts found via queryLocalFonts and
// anything uploaded) used to live only in the modal's own component state, so
// closing and reopening it -- even just re-mounting, e.g. after switching
// tools and back -- meant losing the list entirely: re-clicking "Load fonts
// from this PC" (a browser permission already granted needs no new prompt,
// so that call itself is instant, but the click was still required) and
// re-uploading any custom font file. Caching the merged list at module scope
// means it survives the modal unmounting; it's still per-tab (a full page
// reload clears it, same as any other in-memory cache), not persisted to
// disk -- an uploaded font's bytes can't be remembered across a reload
// without asking the user to pick the file again regardless.
let cachedFontEntries: FontEntry[] = [];

export function getCachedFontEntries(): FontEntry[] {
  return cachedFontEntries;
}

export function cacheFontEntry(entry: FontEntry): void {
  if (!cachedFontEntries.some((f) => f.key === entry.key)) cachedFontEntries = [...cachedFontEntries, entry];
}

/** True only where the Local Font Access API actually exists -- Chrome/Edge on a
 * secure origin (HTTPS or localhost). Firefox/Safari never have it; check this
 * before offering the "load system fonts" button instead of letting the call
 * throw and showing a confusing error. */
export function supportsLocalFontAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/** Triggers the browser's local-font permission prompt the *first* time it's
 * called without prior grant (needs a real user gesture then); once granted,
 * subsequent calls in the same tab -- including this function's own automatic
 * retry on every fresh modal mount -- resolve silently with no new prompt.
 * Returns every installed font as a lazily-loadable FontEntry, including
 * fonts the user has sideloaded/installed themselves -- the OS font list, not
 * a curated web-font set. Throws if the user denies the permission, the
 * browser doesn't support it, or (pre-grant) it's called without a user
 * gesture; callers should catch and fall back to manual upload / the button. */
export async function requestLocalFonts(): Promise<FontEntry[]> {
  if (!window.queryLocalFonts) {
    throw new Error('This browser does not support automatic system font detection (Chrome or Edge required). Upload a font file instead.');
  }
  const fonts = await window.queryLocalFonts();
  // A family with multiple styles (Regular/Bold/Italic/...) lists one FontData
  // per style -- keep them all, distinguished in the label, so e.g. "Arial Bold"
  // is a separate pickable entry from "Arial".
  const entries = fonts.map((f) => ({
    key: f.postscriptName,
    displayName: f.style && f.style !== 'Regular' ? `${f.family} ${f.style}` : f.family,
    source: 'local' as const,
    load: () => loadCached(f.postscriptName, async () => {
      const blob = await f.blob();
      return opentype.parse(await blob.arrayBuffer());
    }),
  }));
  const byKey = new Map(cachedFontEntries.map((f) => [f.key, f]));
  for (const e of entries) byKey.set(e.key, e);
  cachedFontEntries = [...byKey.values()];
  return entries;
}

const RECENT_FONTS_KEY = 'embroidery-digitizer-recent-fonts';
const MAX_RECENT_FONTS = 8;

/** Font keys (most-recent first) the user has actually added text with, so the
 * text tool can surface a "Recently used" shortlist instead of making them
 * hunt through a system font list that can run into the hundreds. Persisted
 * to localStorage -- unlike the in-memory font list cache above, this is
 * meant to survive closing the tab/browser entirely. */
export function getRecentFontKeys(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FONTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addRecentFontKey(key: string): void {
  try {
    const existing = getRecentFontKeys().filter((k) => k !== key);
    const updated = [key, ...existing].slice(0, MAX_RECENT_FONTS);
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(updated));
  } catch {
    // storage full/unavailable -- recency is a convenience, not essential
  }
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
