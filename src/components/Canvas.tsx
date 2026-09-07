import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, defaultObject } from '../state/store';
import type { EmbObject, PathPoint, Point } from '../types';
import { generateObjectStitches } from '../stitching/engine';
import { distanceToPolyline, flattenPath, pointInPolygon } from '../stitching/geometry';

const VERTEX_HIT_PX = 9;
const OBJECT_HIT_PX = 8;

interface View {
  scale: number; // px per mm
  panX: number; // px
  panY: number; // px
}

function rgbCss(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export default function Canvas() {
  const { doc, dispatch, selectedId, setSelectedId, tool, activeColor } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 3.5, panX: 0, panY: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const centeredRef = useRef(false);
  const [showStitchPreview, setShowStitchPreview] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<PathPoint[] | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const dragRef = useRef<
    | { kind: 'pan'; startPx: Point; startPan: Point }
    | { kind: 'move-object'; id: string; startMm: Point; original: PathPoint[] }
    | { kind: 'move-vertex'; id: string; index: number }
    | { kind: 'rect'; corner: Point; ellipse: boolean }
    | null
  >(null);

  const toDesign = useCallback(
    (px: number, py: number): Point => ({
      x: (px - view.panX) / view.scale,
      y: (py - view.panY) / view.scale,
    }),
    [view],
  );

  const toScreen = useCallback((p: Point): Point => ({ x: p.x * view.scale + view.panX, y: p.y * view.scale + view.panY }), [view]);

  // Track the container's real pixel size (it's 0 on first paint, before flex layout settles).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Center the hoop the first time we get a real size, and re-center whenever the hoop changes.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    if (centeredRef.current) return;
    centeredRef.current = true;
    setView((v) => ({ ...v, panX: size.w / 2, panY: size.h / 2 }));
  }, [size]);

  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    setView((v) => ({ ...v, panX: size.w / 2, panY: size.h / 2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.hoop]);

  const getObjectAt = useCallback(
    (p: Point): EmbObject | null => {
      for (let i = doc.objects.length - 1; i >= 0; i--) {
        const o = doc.objects[i];
        if (!o.visible || o.locked) continue;
        const closed = o.kind === 'fill';
        const flat = flattenPath(o.points, closed);
        if (o.kind === 'fill') {
          if (pointInPolygon(p, flat)) return o;
          if (distanceToPolyline(p, flat, true) < OBJECT_HIT_PX / view.scale) return o;
        } else {
          const threshold = Math.max(OBJECT_HIT_PX / view.scale, o.kind === 'satin' ? o.satin.width / 2 : 0);
          if (distanceToPolyline(p, flat, false) < threshold) return o;
        }
      }
      return null;
    },
    [doc.objects, view.scale],
  );

  const getVertexAt = useCallback(
    (p: Point, obj: EmbObject): number => {
      const thresholdMm = VERTEX_HIT_PX / view.scale;
      for (let i = 0; i < obj.points.length; i++) {
        const d = Math.hypot(obj.points[i].x - p.x, obj.points[i].y - p.y);
        if (d < thresholdMm) return i;
      }
      return -1;
    },
    [view.scale],
  );

  const finishDrawing = useCallback(
    (cancel: boolean) => {
      if (drawingPoints && !cancel && drawingPoints.length >= 2 && (tool === 'running' || tool === 'satin' || tool === 'fill')) {
        const obj = defaultObject(tool, drawingPoints, activeColor);
        dispatch({ type: 'ADD_OBJECT', object: obj });
        setSelectedId(obj.id);
      }
      setDrawingPoints(null);
    },
    [drawingPoints, tool, activeColor, dispatch, setSelectedId],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const p = toDesign(px, py);
    (e.target as Element).setPointerCapture(e.pointerId);

    if (e.button === 1 || tool === 'select') {
      if (tool === 'select') {
        const selected = doc.objects.find((o) => o.id === selectedId);
        if (selected && !selected.locked) {
          const vi = getVertexAt(p, selected);
          if (vi >= 0) {
            dragRef.current = { kind: 'move-vertex', id: selected.id, index: vi };
            return;
          }
        }
        const hit = getObjectAt(p);
        if (hit) {
          setSelectedId(hit.id);
          if (!hit.locked) dragRef.current = { kind: 'move-object', id: hit.id, startMm: p, original: hit.points.map((pt) => ({ ...pt })) };
          return;
        }
        setSelectedId(null);
      }
      dragRef.current = { kind: 'pan', startPx: { x: px, y: py }, startPan: { x: view.panX, y: view.panY } };
      return;
    }

    if (tool === 'rect' || tool === 'ellipse') {
      dragRef.current = { kind: 'rect', corner: p, ellipse: tool === 'ellipse' };
      return;
    }

    // running / satin / fill: click-to-place-vertex polyline drawing.
    // Left click = corner (straight, square handle); right click = curve (smooth, circle handle).
    const pt: PathPoint = { ...p, type: e.button === 2 ? 'curve' : 'corner' };
    setDrawingPoints((prev) => (prev ? [...prev, pt] : [pt]));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const p = toDesign(px, py);
    setMousePos(p);

    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, panX: drag.startPan.x + (px - drag.startPx.x), panY: drag.startPan.y + (py - drag.startPx.y) }));
    } else if (drag.kind === 'move-object') {
      const dx = p.x - drag.startMm.x;
      const dy = p.y - drag.startMm.y;
      dispatch({
        type: 'UPDATE_OBJECT',
        id: drag.id,
        patch: { points: drag.original.map((pt) => ({ x: pt.x + dx, y: pt.y + dy, type: pt.type })) },
      });
    } else if (drag.kind === 'move-vertex') {
      const obj = doc.objects.find((o) => o.id === drag.id);
      if (obj) {
        const pts = obj.points.map((pt, i) => (i === drag.index ? { ...p, type: pt.type } : pt));
        dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch: { points: pts } });
      }
    } else if (drag.kind === 'rect') {
      const target = e.shiftKey ? constrainToSquare(drag.corner, p) : p;
      setDrawingPoints(rectPoints(drag.corner, target, drag.ellipse));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (drag?.kind === 'rect') {
      const pts = drawingPoints;
      setDrawingPoints(null);
      if (pts && pts.length >= 3) {
        const obj = defaultObject('fill', pts, activeColor);
        dispatch({ type: 'ADD_OBJECT', object: obj });
        setSelectedId(obj.id);
      }
    }
    dragRef.current = null;
  };

  const onDoubleClick = () => finishDrawing(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') finishDrawing(false);
      if (e.key === 'Escape') finishDrawing(true);
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId && document.activeElement?.tagName !== 'INPUT') {
          dispatch({ type: 'REMOVE_OBJECT', id: selectedId });
          setSelectedId(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishDrawing, selectedId, dispatch, setSelectedId]);

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = toDesign(px, py);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(20, Math.max(0.6, view.scale * factor));
    const newPanX = px - before.x * newScale;
    const newPanY = py - before.y * newScale;
    setView({ scale: newScale, panX: newPanX, panY: newPanY });
  };

  // --- Rendering ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = '#eeeae0';
    ctx.fillRect(0, 0, w, h);

    // hoop
    const hw = doc.hoop.width;
    const hh = doc.hoop.height;
    const topLeft = toScreen({ x: -hw / 2, y: -hh / 2 });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(topLeft.x, topLeft.y, hw * view.scale, hh * view.scale);
    ctx.strokeStyle = '#b9b2a3';
    ctx.lineWidth = 1;
    ctx.strokeRect(topLeft.x, topLeft.y, hw * view.scale, hh * view.scale);

    // center crosshair
    const center = toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = '#d8d2c4';
    ctx.beginPath();
    ctx.moveTo(center.x - 6, center.y);
    ctx.lineTo(center.x + 6, center.y);
    ctx.moveTo(center.x, center.y - 6);
    ctx.lineTo(center.x, center.y + 6);
    ctx.stroke();

    for (const obj of doc.objects) {
      if (!obj.visible) continue;
      drawObject(ctx, obj, toScreen, view.scale, obj.id === selectedId, showStitchPreview);
    }

    if (drawingPoints && drawingPoints.length > 0) {
      const withCursor: PathPoint[] =
        mousePos && tool !== 'rect' && tool !== 'ellipse'
          ? [...drawingPoints, { ...mousePos, type: 'corner' }]
          : drawingPoints;
      const flat = flattenPath(withCursor, false);
      ctx.strokeStyle = '#2f6fed';
      ctx.fillStyle = '#2f6fed';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const first = toScreen(flat[0]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < flat.length; i++) {
        const s = toScreen(flat[i]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of drawingPoints) drawVertexMarker(ctx, toScreen(p), p.type, '#2f6fed', '#2f6fed');
    }
  }, [doc, view, size, selectedId, showStitchPreview, drawingPoints, mousePos, toScreen]);

  return (
    <div className="canvas-wrap" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="canvas-hint">
        {tool === 'select'
          ? 'Click to select · drag to move · Delete to remove'
          : tool === 'rect' || tool === 'ellipse'
            ? 'Drag to draw the shape · hold Shift to keep it square/circular'
            : 'Left-click = corner point (▪) · right-click = curve point (●) · double-click or Enter to finish · Esc to cancel'}
      </div>
      <div className="canvas-controls">
        <label>
          <input type="checkbox" checked={showStitchPreview} onChange={(e) => setShowStitchPreview(e.target.checked)} />
          Stitch preview
        </label>
        <div className="zoom-controls">
          <button onClick={() => setView((v) => ({ ...v, scale: Math.max(0.6, v.scale / 1.2) }))}>−</button>
          <span>{Math.round(view.scale * 10)}%</span>
          <button onClick={() => setView((v) => ({ ...v, scale: Math.min(20, v.scale * 1.2) }))}>+</button>
        </div>
      </div>
    </div>
  );
}

/** Anchors the drag at `a` and forces `b` so the box is a square (shift-constrain). */
function constrainToSquare(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + (dx < 0 ? -size : size), y: a.y + (dy < 0 ? -size : size) };
}

function rectPoints(a: Point, b: Point, ellipse: boolean): PathPoint[] {
  if (!ellipse) {
    return [
      { x: a.x, y: a.y, type: 'corner' },
      { x: b.x, y: a.y, type: 'corner' },
      { x: b.x, y: b.y, type: 'corner' },
      { x: a.x, y: b.y, type: 'corner' },
    ];
  }
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const pts: PathPoint[] = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, type: 'curve' });
  }
  return pts;
}

function drawVertexMarker(ctx: CanvasRenderingContext2D, s: Point, type: 'corner' | 'curve', fill: string, stroke: string) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  if (type === 'curve') {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    if (stroke !== fill) ctx.stroke();
  } else {
    const r = 4;
    ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    if (stroke !== fill) ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  obj: EmbObject,
  toScreen: (p: Point) => Point,
  scale: number,
  selected: boolean,
  stitchPreview: boolean,
) {
  const color = rgbCss(obj.color);

  if (stitchPreview) {
    const stitches = generateObjectStitches(obj);
    if (stitches.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, scale * 0.28);
      ctx.beginPath();
      const first = toScreen(stitches[0]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stitches.length; i++) {
        const s = toScreen(stitches[i]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    }
  } else if (obj.kind === 'fill') {
    const flat = flattenPath(obj.points, true);
    ctx.beginPath();
    const first = toScreen(flat[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < flat.length; i++) {
      const s = toScreen(flat[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    const flat = flattenPath(obj.points, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = obj.kind === 'satin' ? Math.max(2, obj.satin.width * scale) : 2;
    ctx.globalAlpha = obj.kind === 'satin' ? 0.5 : 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const first = toScreen(flat[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < flat.length; i++) {
      const s = toScreen(flat[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (obj.kind === 'satin') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  if (selected) {
    for (const p of obj.points) drawVertexMarker(ctx, toScreen(p), p.type, '#2f6fed', '#ffffff');
  }
}
