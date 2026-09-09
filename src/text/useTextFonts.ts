import { useCallback, useEffect, useState } from 'react';
import type * as opentype from 'opentype.js';
import {
  getCachedFontEntries,
  getRecentFontKeys,
  requestLocalFonts,
  supportsLocalFontAccess,
  type FontEntry,
} from '../fonts/fontLoader';

/** The font list, shared by the toolbar picker and anything else that needs it.
 * The browser's local-font permission persists for the tab once granted, so a
 * silent retry on mount means a returning user never has to click "load fonts"
 * a second time; the explicit loader below covers the first-ever use, which
 * needs a real gesture. */
export function useTextFonts(): {
  fonts: FontEntry[];
  loading: boolean;
  canAutoLoad: boolean;
  loadSystemFonts: () => Promise<void>;
  addFonts: (entries: FontEntry[]) => void;
} {
  const [fonts, setFonts] = useState<FontEntry[]>(() => getCachedFontEntries());
  const [loading, setLoading] = useState(false);

  const addFonts = useCallback((entries: FontEntry[]) => {
    setFonts((prev) => {
      const byKey = new Map(prev.map((f) => [f.key, f]));
      for (const f of entries) byKey.set(f.key, f);
      return [...byKey.values()];
    });
  }, []);

  const loadSystemFonts = useCallback(async () => {
    setLoading(true);
    try {
      const found = await requestLocalFonts();
      found.sort((a, b) => a.displayName.localeCompare(b.displayName));
      addFonts(found);
    } finally {
      setLoading(false);
    }
  }, [addFonts]);

  useEffect(() => {
    if (fonts.length > 0 || !supportsLocalFontAccess()) return;
    requestLocalFonts()
      .then((found) => {
        found.sort((a, b) => a.displayName.localeCompare(b.displayName));
        addFonts(found);
      })
      .catch(() => {
        // First use in this tab has no gesture yet -- the button handles it.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { fonts, loading, canAutoLoad: supportsLocalFontAccess(), loadSystemFonts, addFonts };
}

/** Sorts a font list so the ones just used come first. */
export function orderByRecent(fonts: FontEntry[]): { recent: FontEntry[]; others: FontEntry[] } {
  const keys = getRecentFontKeys();
  const recent = keys.map((k) => fonts.find((f) => f.key === k)).filter((f): f is FontEntry => !!f);
  return { recent, others: fonts.filter((f) => !keys.includes(f.key)) };
}

/** Resolves a font key to a parsed font. Returns null while loading or when no
 * font is chosen, so a caller can render nothing rather than guess. */
export function useLoadedFont(key: string, fonts: FontEntry[]): opentype.Font | null {
  const [font, setFont] = useState<opentype.Font | null>(null);
  useEffect(() => {
    let cancelled = false;
    const entry = fonts.find((f) => f.key === key);
    if (!entry) {
      setFont(null);
      return;
    }
    entry
      .load()
      .then((f) => {
        if (!cancelled) setFont(f);
      })
      .catch(() => {
        if (!cancelled) setFont(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, fonts]);
  return font;
}
