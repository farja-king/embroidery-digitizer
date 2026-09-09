import { useState } from 'react';
import { useStore } from '../state/store';
import type { ToolId } from '../types';
import ThreadPaletteModal from './ThreadPaletteModal';
import TextModal from './TextModal';

const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'select', label: '↖', hint: 'Select' },
  { id: 'running', label: '⌇', hint: 'Running stitch' },
  { id: 'satin', label: '▤', hint: 'Satin column' },
  { id: 'fill', label: '◆', hint: 'Fill (tatami)' },
  { id: 'rect', label: '▭', hint: 'Rectangle fill' },
  { id: 'ellipse', label: '◯', hint: 'Ellipse fill' },
  { id: 'text', label: 'T', hint: 'Text — click in the hoop and type' },
];

const SWATCHES = [
  { r: 237, g: 23, b: 31 },
  { r: 10, g: 85, b: 163 },
  { r: 0, g: 0, b: 0 },
  { r: 240, g: 240, b: 240 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 135, b: 119 },
  { r: 254, g: 186, b: 53 },
  { r: 106, g: 28, b: 138 },
];

export default function Toolbar() {
  const { tool, setTool, activeColor, setActiveColor, selectedIds, dispatch } = useStore();
  const [showPalette, setShowPalette] = useState(false);
  const [showText, setShowText] = useState(false);

  // With one or more objects selected, a swatch click recolors them directly —
  // faster than opening Properties per-object when batch-coloring a multi-color
  // design. With nothing selected it just sets the color new shapes will draw with.
  const applyColor = (c: { r: number; g: number; b: number }) => {
    setActiveColor(c);
    for (const id of selectedIds) dispatch({ type: 'UPDATE_OBJECT', id, patch: { color: c } });
  };

  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          title={t.hint}
          onClick={() => setTool(t.id)}
        >
          {t.label}
        </button>
      ))}
      <button className="tool-btn" title="Add text from a dialog (font, size and stitch type in one place)" onClick={() => setShowText(true)}>
        🔤
      </button>
      <div className="toolbar-sep" />
      <div className="swatches">
        {SWATCHES.map((c, i) => (
          <button
            key={i}
            className={`swatch ${activeColor.r === c.r && activeColor.g === c.g && activeColor.b === c.b ? 'active' : ''}`}
            style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
            onClick={() => applyColor(c)}
            title={selectedIds.length > 0 ? 'Recolor selection' : 'Thread color'}
          />
        ))}
        <input
          type="color"
          className="color-input"
          value={rgbToHex(activeColor)}
          onChange={(e) => applyColor(hexToRgb(e.target.value))}
          title="Custom thread color"
        />
        <button className="palette-open-btn" onClick={() => setShowPalette(true)} title="Madeira Classic 40 / Polyneon thread palette">
          🧵
        </button>
      </div>
      {showPalette && (
        <ThreadPaletteModal
          onPick={(c) => applyColor(c)}
          onClose={() => setShowPalette(false)}
        />
      )}
      {showText && <TextModal color={activeColor} onClose={() => setShowText(false)} />}
    </div>
  );
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
