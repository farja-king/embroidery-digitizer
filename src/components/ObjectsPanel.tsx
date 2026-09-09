import { useRef } from 'react';
import { useStore, makeId } from '../state/store';

const KIND_LABEL: Record<string, string> = { running: 'Running', satin: 'Satin', fill: 'Fill' };

export default function ObjectsPanel() {
  const { doc, dispatch, selectedId, setSelectedId, selectedIds, setSelectedIds } = useStore();
  // Range-select anchor for Shift+click — the last item picked by a plain or
  // Ctrl+click, matching the usual file-manager/list convention: Shift extends
  // from this anchor without moving it, so repeated Shift+clicks (even to a point
  // earlier than the previous one) keep resizing the same range.
  const anchorRef = useRef<number | null>(null);

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= doc.objects.length) return;
    dispatch({ type: 'REORDER', fromIndex: index, toIndex: to });
  };

  const selectRow = (e: React.MouseEvent, index: number, id: string) => {
    if (e.shiftKey && anchorRef.current !== null) {
      const [lo, hi] = anchorRef.current < index ? [anchorRef.current, index] : [index, anchorRef.current];
      setSelectedIds(doc.objects.slice(lo, hi + 1).map((o) => o.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
      anchorRef.current = index;
      return;
    }
    setSelectedId(id);
    anchorRef.current = index;
  };

  return (
    <div className="panel">
      <h3>Stitch order</h3>
      {doc.objects.length === 0 && <p className="muted">No objects yet. Pick a tool and start drawing.</p>}
      <ul className="object-list">
        {doc.objects.map((o, i) => (
          <li key={o.id} className={selectedIds.includes(o.id) ? 'selected' : ''} onClick={(e) => selectRow(e, i, o.id)}>
            <span className="obj-swatch" style={{ background: `rgb(${o.color.r},${o.color.g},${o.color.b})` }} />
            <span className="obj-name">
              {i + 1}. {o.name} <em>{KIND_LABEL[o.kind]}</em>
            </span>
            <span className="obj-actions">
              <button title="Move up" onClick={(e) => { e.stopPropagation(); move(i, -1); }}>
                ↑
              </button>
              <button title="Move down" onClick={(e) => { e.stopPropagation(); move(i, 1); }}>
                ↓
              </button>
              <button
                className={`icon-toggle ${o.visible ? 'is-on' : 'is-off'}`}
                title={o.visible ? 'Hide' : 'Show'}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'UPDATE_OBJECT', id: o.id, patch: { visible: !o.visible } }); }}
              >
                <span key={o.visible ? 'on' : 'off'} className="icon-pop">
                  {o.visible ? '◉' : '○'}
                </span>
              </button>
              <button
                className={`icon-toggle lock-toggle ${o.locked ? 'is-on' : 'is-off'}`}
                title={o.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'UPDATE_OBJECT', id: o.id, patch: { locked: !o.locked } }); }}
              >
                <span key={o.locked ? 'locked' : 'unlocked'} className="icon-pop">
                  {o.locked ? '🔒' : '🔓'}
                </span>
              </button>
              <button
                title="Duplicate (Ctrl+D)"
                onClick={(e) => {
                  e.stopPropagation();
                  const newId = makeId();
                  dispatch({ type: 'DUPLICATE_OBJECT', id: o.id, newId });
                  setSelectedId(newId);
                }}
              >
                ⧉
              </button>
              <button
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'REMOVE_OBJECT', id: o.id });
                  if (selectedId === o.id) setSelectedId(null);
                }}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
