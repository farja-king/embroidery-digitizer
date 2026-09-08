import { useState } from 'react';
import { requestLocalFonts, loadUploadedFont, supportsLocalFontAccess, type FontEntry } from '../fonts/fontLoader';
import { textToObjects } from '../text/textToObjects';
import { useStore } from '../state/store';
import type { RGB } from '../types';

export default function TextModal({ color, onClose }: { color: RGB; onClose: () => void }) {
  const { doc, dispatch, setSelectedIds } = useStore();
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [text, setText] = useState('Text');
  const [sizeMm, setSizeMm] = useState(20);
  const [x, setX] = useState(Math.round(doc.hoop.width / 2 - 20));
  const [y, setY] = useState(Math.round(doc.hoop.height / 2));
  const [stitchStyle, setStitchStyle] = useState<'satin-auto' | 'fill'>('satin-auto');
  const [underlayMode, setUnderlayMode] = useState<'auto' | 'none'>('auto');
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const selectedFont = fonts.find((f) => f.key === selectedKey) ?? null;

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
      const objects = textToObjects({ text, font, sizeMm, x, y, color, stitchStyle, underlayMode });
      if (objects.length === 0) {
        setError('That text produced no stitchable shapes (font may be missing those glyphs).');
        return;
      }
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
            {fonts.map((f) => (
              <option key={f.key} value={f.key}>
                {f.displayName}
                {f.source === 'upload' ? ' (uploaded)' : ''}
              </option>
            ))}
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
            Size (mm)
            <input type="number" min={2} max={300} step={0.5} value={sizeMm} onChange={(e) => setSizeMm(Number(e.target.value))} />
          </label>
        </div>
        <div className="field row">
          <label style={{ flex: 1 }}>
            X (mm)
            <input type="number" value={x} onChange={(e) => setX(Number(e.target.value))} />
          </label>
          <label style={{ flex: 1 }}>
            Y (mm)
            <input type="number" value={y} onChange={(e) => setY(Number(e.target.value))} />
          </label>
        </div>

        <label className="field">
          Stitch type
          <select value={stitchStyle} onChange={(e) => setStitchStyle(e.target.value as 'satin-auto' | 'fill')}>
            <option value="satin-auto">Satin (auto — fill only where a letter can't be one clean stroke)</option>
            <option value="fill">Fill (every letter, regardless of shape)</option>
          </select>
        </label>

        <label className="field">
          Underlay
          <select value={underlayMode} onChange={(e) => setUnderlayMode(e.target.value as 'auto' | 'none')}>
            <option value="auto">Auto (same default every other shape gets)</option>
            <option value="none">None</option>
          </select>
        </label>

        <p className="muted small">
          Letters use the real outline of whichever font you pick, with correctly cut-out counters (the holes in
          "O", "A", "B", …). In "Satin" mode, each letter is tried as one continuous satin column following its own
          curve — straight and round strokes usually satin cleanly; strongly curved open strokes ("C", "S") and
          anything with a branch (a joint like "A", "E", "T", …) safely fall back to fill rather than risk a
          distorted column. Every generated letter is a normal shape afterward — select one to fine-tune its angle,
          width, underlay, or convert it by hand.
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
