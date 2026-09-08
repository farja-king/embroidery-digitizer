import { useEffect, useRef } from 'react';
import type { EmbObject, Point, StitchKind } from '../types';

const KIND_LABELS: Record<StitchKind, string> = { running: 'Running', satin: 'Satin', fill: 'Fill' };

export interface ContextMenuState {
  screenX: number;
  screenY: number;
  obj: EmbObject;
  vertexIndex: number | null;
  insertIndex: number | null;
  insertPoint: Point | null;
}

export default function ContextMenu({
  state,
  onClose,
  onDuplicate,
  onDelete,
  onToggleLock,
  onToggleVisible,
  onConvertKind,
  onSetStartPoint,
  onSetEndPoint,
  onReverseDirection,
  onAddPoint,
  onDeletePoint,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleLock: () => void;
  onToggleVisible: () => void;
  onConvertKind: (kind: StitchKind) => void;
  onSetStartPoint: (vertexIndex: number) => void;
  onSetEndPoint: (vertexIndex: number) => void;
  onReverseDirection: () => void;
  onAddPoint: (insertIndex: number, point: Point) => void;
  onDeletePoint: (vertexIndex: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 'click' (not 'mousedown'): the right-click gesture that opens this menu is
    // itself a mousedown, and attaching on 'mousedown' risked catching a leftover
    // event from that same gesture and closing the menu the instant it opened.
    // 'click' only fires on a genuine left-button press+release, so it can't
    // self-trigger from the right-click that mounted this component.
    window.addEventListener('click', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const { obj, vertexIndex, insertIndex, insertPoint } = state;
  const otherKinds = (['running', 'satin', 'fill'] as StitchKind[]).filter((k) => k !== obj.kind);
  const minPoints = obj.kind === 'fill' ? 3 : 2;
  const canDeletePoint = vertexIndex !== null && obj.points.length > minPoints;

  // Keep the menu on-screen near the click point.
  const style: React.CSSProperties = {
    left: Math.min(state.screenX, window.innerWidth - 210),
    top: Math.min(state.screenY, window.innerHeight - 320),
  };

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div className="context-menu" style={style} ref={ref}>
      <button onClick={act(onDuplicate)}>Duplicate</button>
      <div className="context-menu-sep" />
      {otherKinds.map((k) => (
        <button key={k} onClick={act(() => onConvertKind(k))}>
          Convert to {KIND_LABELS[k]}
        </button>
      ))}
      <div className="context-menu-sep" />
      {obj.kind === 'fill' && vertexIndex !== null && (
        <>
          <button onClick={act(() => onSetStartPoint(vertexIndex))}>Set as start point</button>
          <button onClick={act(() => onSetEndPoint(vertexIndex))}>Set as end point</button>
        </>
      )}
      {obj.kind !== 'fill' && <button onClick={act(onReverseDirection)}>Reverse direction</button>}
      {insertIndex !== null && insertPoint && (
        <button onClick={act(() => onAddPoint(insertIndex, insertPoint))}>Add point here</button>
      )}
      {canDeletePoint && vertexIndex !== null && <button onClick={act(() => onDeletePoint(vertexIndex))}>Delete point</button>}
      <div className="context-menu-sep" />
      <button onClick={act(onToggleVisible)}>{obj.visible ? 'Hide' : 'Show'}</button>
      <button onClick={act(onToggleLock)}>{obj.locked ? 'Unlock' : 'Lock'}</button>
      <div className="context-menu-sep" />
      <button className="danger" onClick={act(onDelete)}>
        Delete
      </button>
    </div>
  );
}
