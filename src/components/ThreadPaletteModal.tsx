import { useMemo, useState } from 'react';
import { MADEIRA_CLASSIC_40, MADEIRA_POLYNEON, type ThreadColor } from '../data/threadPalettes';

type PaletteId = 'classic' | 'polyneon';

const PALETTES: Record<PaletteId, { label: string; colors: ThreadColor[] }> = {
  classic: { label: 'Madeira Classic 40 (Rayon)', colors: MADEIRA_CLASSIC_40 },
  polyneon: { label: 'Madeira Polyneon', colors: MADEIRA_POLYNEON },
};

export default function ThreadPaletteModal({
  onPick,
  onClose,
}: {
  onPick: (c: { r: number; g: number; b: number }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PaletteId>('classic');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const colors = PALETTES[tab].colors;
    if (!q) return colors;
    return colors.filter((c) => c.name.toLowerCase().includes(q) || c.code.includes(q));
  }, [tab, search]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal palette-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Thread palette</h3>
        <div className="palette-tabs">
          {(Object.keys(PALETTES) as PaletteId[]).map((id) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {PALETTES[id].label}
            </button>
          ))}
        </div>
        <input
          className="palette-search"
          placeholder="Search by name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <p className="muted palette-count">{filtered.length} colors</p>
        <div className="palette-grid">
          {filtered.map((c) => (
            <button
              key={c.code}
              className="palette-swatch"
              style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
              title={`${c.code} — ${c.name}`}
              onClick={() => onPick({ r: c.r, g: c.g, b: c.b })}
            />
          ))}
        </div>
        <button className="palette-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
