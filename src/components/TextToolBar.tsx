import { useEffect } from 'react';
import { useStore } from '../state/store';
import { loadUploadedFont, cacheFontEntry } from '../fonts/fontLoader';
import { EMBROIDERY_FONT_KEY, EMBROIDERY_FONT_LABEL, orderByRecent, useTextFonts } from '../text/useTextFonts';
import type { FontEntry } from '../fonts/fontLoader';

/** The font and size picker for the type-on-canvas text tool, sitting just to
 * the right of the tool strip. Shown only while the text tool is active, so it
 * never takes up room during ordinary drawing. */
export default function TextToolBar({ fonts, loading, canAutoLoad, loadSystemFonts, addFonts }: ReturnType<typeof useTextFonts>) {
  const { textFontKey, setTextFontKey, textSizeMm, setTextSizeMm, textStitchStyle, setTextStitchStyle } = useStore();
  const { recent, others } = orderByRecent(fonts);

  // The built-in digitized font always works, so there is nothing to wait for.
  useEffect(() => {
    if (textFontKey) return;
    setTextFontKey(EMBROIDERY_FONT_KEY);
  }, [textFontKey, setTextFontKey]);

  const onUpload = async (file: File) => {
    const entry: FontEntry = await loadUploadedFont(file);
    cacheFontEntry(entry);
    addFonts([entry]);
    setTextFontKey(entry.key);
  };

  return (
    <div className="text-toolbar">
      <select
        className="text-toolbar-font"
        value={textFontKey}
        onChange={(e) => setTextFontKey(e.target.value)}
        title="Font"
      >
        <option value={EMBROIDERY_FONT_KEY}>{EMBROIDERY_FONT_LABEL}</option>
        {recent.length > 0 && (
          <optgroup label="Recently used">
            {recent.map((f) => (
              <option key={f.key} value={f.key}>{f.displayName}</option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="All fonts">
            {others.map((f) => (
              <option key={f.key} value={f.key}>{f.displayName}</option>
            ))}
          </optgroup>
        )}
      </select>

      <label className="text-toolbar-size" title="Capital letter height in millimetres — measure a capital on the finished design and it will read this">
        <input
          type="number"
          min={2}
          max={300}
          step={0.5}
          value={textSizeMm}
          onChange={(e) => setTextSizeMm(Number(e.target.value) || 1)}
        />
        mm
      </label>

      <select
        className="text-toolbar-style"
        value={textStitchStyle}
        onChange={(e) => setTextStitchStyle(e.target.value as 'satin-auto' | 'fill')}
        title="How each letter is stitched"
      >
        <option value="satin-auto">Satin</option>
        <option value="fill">Fill</option>
      </select>

      {fonts.length === 0 && canAutoLoad && (
        <button type="button" onClick={loadSystemFonts} disabled={loading}>
          {loading ? 'Loading…' : 'Load fonts'}
        </button>
      )}
      <label className="text-toolbar-upload" title="Use a .ttf/.otf file">
        ＋
        <input
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = '';
          }}
        />
      </label>

      <span className="text-toolbar-hint">Click in the hoop and type</span>
    </div>
  );
}
