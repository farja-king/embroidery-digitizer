import { useEffect, useState } from 'react';
import {
  requestLocalFonts,
  loadUploadedFont,
  supportsLocalFontAccess,
  getCachedFontEntries,
  cacheFontEntry,
  getRecentFontKeys,
  addRecentFontKey,
  type FontEntry,
} from '../fonts/fontLoader';
import { textToObjects } from '../text/textToObjects';
import { useStore } from '../state/store';
import type { RGB } from '../types';

export default function TextModal({ color, onClose }: { color: RGB; onClose: () => void }) {
  const { dispatch, setSelectedIds } = useStore();
  const [fonts, setFonts] = useState<FontEntry[]>(() => getCachedFontEntries());
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [text, setText] = useState('Text');
  const [sizeMm, setSizeMm] = useState(20);
  // No X/Y fields: text from this dialog lands in the middle of the hoop and is
  // dragged from there, and the text tool types wherever you click. Two ways to
  // set a position, neither of them a pair of numbers to work out by hand.
  const [stitchStyle, setStitchStyle] = useState<'satin-auto' | 'fill'>('satin-auto');
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const recentKeys = getRecentFontKeys();
  const recentFonts = recentKeys.map((k) => fonts.find((f) => f.key === k)).filter((f): f is FontEntry => !!f);
  const otherFonts = fonts.filter((f) => !recentKeys.includes(f.key));

  const selectedFont = fonts.find((f) => f.key === selectedKey) ?? null;

  // Default to the most recently used font once the list is available, so a
  // returning user doesn't have to pick again for a font they just used.
  useEffect(() => {
    if (selectedKey || fonts.length === 0) return;
    setSelectedKey((recentFonts[0] ?? fonts[0]).key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonts]);

  // Once granted, the browser's local-font permission persists for the tab --
  // a fresh queryLocalFonts() call resolves instantly with no new prompt. If
  // the cache is already warm (this modal was opened before, or a permission
  // grant already happened this session) skip straight to it; otherwise try
  // once automatically so a *returning* user never has to click "Load fonts"
  // again. This silently does nothing if the browser requires a fresh click
  // (no prior grant this tab) -- the button below still covers that case.
  useEffect(() => {
    if (fonts.length > 0 || !supportsLocalFontAccess()) return;
    requestLocalFonts()
      .then((found) => {
        found.sort((a, b) => a.displayName.localeCompare(b.displayName));
        setFonts((prev) => mergeFonts(prev, found));
      })
      .catch(() => {
        // Expected on a first-ever use in this tab (no gesture yet) -- the
        // "Load fonts from this PC" button below handles that click.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSystemFonts = async () => {
    setLoadingFonts(true);
    setError(null);
    try {
      const found = await requestLocalFonts();
      found.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setFonts((prev) => mergeFonts(prev, found));
      if (found.length > 0 && !selectedKey) setSelectedKey(found[0].key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load system fonts.');
    } finally {
      setLoadingFonts(false);
    }
  };

  const onUpload = async (file: File) => {
    setError(null);
    try {
      const entry = await loadUploadedFont(file);
      cacheFontEntry(entry);
      setFonts((prev) => mergeFonts(prev, [entry]));
      setSelectedKey(entry.key);
    } catch {
      setError(`Could not read "${file.name}" as a font file (.ttf/.otf/.woff).`);
    }
  };

  const addText = async () => {
    if (!selectedFont || !text.trim()) return;
    setBuilding(true);
    setError(null);
    try {
      const font = await selectedFont.load();
      // Roughly centred: textToObjects lays out from a baseline start point, so
      // back off by half the string's drawn width and drop the baseline by
      // about half a cap height.
      const advance = font.getAdvanceWidth(text, sizeMm);
      const objects = textToObjects({
        text,
        font,
        sizeMm,
        x: -advance / 2,
        y: sizeMm * 0.35,
        color,
        stitchStyle,
      });
      if (objects.length === 0) {
        setError('That text produced no stitchable shapes (font may be missing those glyphs).');
        return;
      }
      addRecentFontKey(selectedFont.key);
      dispatch({ type: 'ADD_OBJECTS', objects });
      setSelectedIds(objects.map((o) => o.id));
      onClose();
    } catch {
      setError('Could not read that font file.');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal text-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add text</h3>

        <label className="field">
          Text
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>

        <label className="field">
          Font
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} disabled={fonts.length === 0}>
            {fonts.length === 0 && <option value="">No fonts loaded yet</option>}
            {recentFonts.length > 0 && (
              <optgroup label="Recently used">
                {recentFonts.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.displayName}
                    {f.source === 'upload' ? ' (uploaded)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {otherFonts.length > 0 && (
              <optgroup label="All fonts">
                {otherFonts.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.displayName}
                    {f.source === 'upload' ? ' (uploaded)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <div className="text-modal-font-actions">
          {supportsLocalFontAccess() ? (
            <button type="button" className="secondary-btn" onClick={loadSystemFonts} disabled={loadingFonts}>
              {loadingFonts ? 'Loading…' : fonts.some((f) => f.source === 'local') ? 'Reload system fonts' : 'Load fonts from this PC'}
            </button>
          ) : (
            <p className="muted small">
              Automatic font detection needs Chrome or Edge — upload a font file instead.
            </p>
          )}
          <label className="secondary-btn upload-font-btn">
            Upload font file…
            <input
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="field row">
          <label style={{ flex: 1 }}>
            Capital height (mm)
            <input type="number" min={2} max={300} step={0.5} value={sizeMm} onChange={(e) => setSizeMm(Number(e.target.value))} />
          </label>
        </div>

        <label className="field">
          Stitch type
          <select value={stitchStyle} onChange={(e) => setStitchStyle(e.target.value as 'satin-auto' | 'fill')}>
            <option value="satin-auto">Satin (auto, fill where needed)</option>
            <option value="fill">Fill (every letter)</option>
          </select>
        </label>

        <p className="muted small">
          Letters use the real outline of your chosen font, with correctly cut-out counters ("O", "A", "B", …). In
          "Satin" mode each letter is tried as one satin column following its own curve; anything too curved or
          branching (a joint like "A", "E", "T") safely falls back to fill. Each letter is a normal shape
          afterward — select one in Properties to fine-tune its angle, width, or underlay.
        </p>

        {error && <p className="text-modal-error">{error}</p>}

        <div className="text-modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={addText} disabled={!selectedFont || !text.trim() || building}>
            {building ? 'Adding…' : 'Add to design'}
          </button>
        </div>
      </div>
    </div>
  );
}

function mergeFonts(prev: FontEntry[], next: FontEntry[]): FontEntry[] {
  const byKey = new Map(prev.map((f) => [f.key, f]));
  for (const f of next) byKey.set(f.key, f);
  return [...byKey.values()];
}
