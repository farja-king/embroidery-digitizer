import { useRef, useState } from 'react';
import { useStore } from '../state/store';

const MAX_DIMENSION = 1600; // cap the stored image size so it doesn't bloat localStorage/project files

function downscaleToDataUrl(file: File): Promise<{ src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not process image'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ src: canvas.toDataURL('image/jpeg', 0.85), width: img.width, height: img.height });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Could not load that image'));
    img.src = URL.createObjectURL(file);
  });
}

export default function BackgroundControls() {
  const { doc, dispatch } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const bg = doc.background;

  const addImage = async (file: File) => {
    try {
      const { src, width, height } = await downscaleToDataUrl(file);
      // Fit within ~80% of the hoop's shorter side, preserving aspect ratio.
      const maxSpan = Math.min(doc.hoop.width, doc.hoop.height) * 0.8;
      const aspect = width / height;
      const w = aspect >= 1 ? maxSpan : maxSpan * aspect;
      const h = aspect >= 1 ? maxSpan / aspect : maxSpan;
      dispatch({
        type: 'SET_BACKGROUND',
        background: { src, x: 0, y: 0, width: w, height: h, opacity: 0.5, visible: true },
      });
      setOpen(true);
    } catch {
      // silently ignore a bad file; nothing was changed
    }
  };

  return (
    <div className="bg-controls">
      <button
        className="bg-toggle-btn"
        onClick={() => (bg ? setOpen((o) => !o) : fileInputRef.current?.click())}
        title="Background template image"
      >
        🖼 {bg ? (bg.visible ? 'Background' : 'Background (hidden)') : 'Add background'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addImage(f);
          e.target.value = '';
        }}
      />
      {open && bg && (
        <div className="bg-popover">
          <label className="field row">
            <input type="checkbox" checked={bg.visible} onChange={(e) => dispatch({ type: 'UPDATE_BACKGROUND', patch: { visible: e.target.checked } })} />
            Visible <span className="muted">(toggle with D)</span>
          </label>
          <label className="field">
            Opacity
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={bg.opacity}
              onChange={(e) => dispatch({ type: 'UPDATE_BACKGROUND', patch: { opacity: parseFloat(e.target.value) } })}
            />
          </label>
          <label className="field">
            Size (mm, longest side)
            <input
              type="number"
              min={5}
              max={1000}
              value={Math.round(Math.max(bg.width, bg.height) * 10) / 10}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isNaN(v) || v <= 0) return;
                const aspect = bg.width / bg.height;
                const [w, h] = aspect >= 1 ? [v, v / aspect] : [v * aspect, v];
                dispatch({ type: 'UPDATE_BACKGROUND', patch: { width: w, height: h } });
              }}
            />
          </label>
          <div className="bg-popover-actions">
            <button onClick={() => fileInputRef.current?.click()}>Replace image</button>
            <button
              className="danger"
              onClick={() => {
                dispatch({ type: 'SET_BACKGROUND', background: null });
                setOpen(false);
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
