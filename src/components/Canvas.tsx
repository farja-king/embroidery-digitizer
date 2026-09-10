import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, defaultObject, makeId, transformFillAnchors } from '../state/store';
import { textToObjects } from '../text/textToObjects';
import { useLoadedFont, useTextFonts } from '../text/useTextFonts';
import TextToolBar from './TextToolBar';
import type { EmbObject, FillParams, Guide, PathPoint, Point } from '../types';
import { buildPattern, generateObjectStitches, type StitchPoint } from '../stitching/engine';
import { distanceToPolyline, distanceToSegment, flattenPath, pointInPolygon, rotatePoint } from '../stitching/geometry';
import { pointsForKindChange } from '../stitching/kindConvert';
import BackgroundControls from './BackgroundControls';
import ContextMenu, { type ContextMenuState } from './ContextMenu';

const VERTEX_HIT_PX = 9;
const OBJECT_HIT_PX = 8;
// The resize/rotate handle frame sits this many screen px outside the selection's
// true content bounding box — never coincides with an on-path vertex (which is
// always on or inside that box), so a click always unambiguously means "transform
// the whole shape" vs. "move this one point".
const HANDLE_OUTSET_PX = 12;
const HANDLE_HIT_PX = 12;
const ROTATE_OFFSET_PX = 22;

type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLE_DIRS: HandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RESIZE_CURSORS: Record<HandleDir, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function handleScreenPositions(box: ScreenBox): Record<HandleDir, Point> {
  const { x0, y0, x1, y1 } = box;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return {
    nw: { x: x0, y: y0 },
    n: { x: mx, y: y0 },
    ne: { x: x1, y: y0 },
    e: { x: x1, y: my },
    se: { x: x1, y: y1 },
    s: { x: mx, y: y1 },
    sw: { x: x0, y: y1 },
    w: { x: x0, y: my },
  };
}

interface View {
  scale: number; // px per mm
  panX: number; // px
  panY: number; // px
}

const RULER_PX = 18;
// Snap radius in screen pixels, converted to mm at the current zoom -- so it
// always feels like the same distance on screen rather than getting harder to
// hit the further you zoom in.
const SNAP_MM = 6;

/** Limits a move so whatever is being dragged stays inside the hoop. Anything
 * outside the hoop cannot be stitched, so letting a shape be dragged off the
 * edge only produces a design that fails at the machine.
 *
 * An object already larger than the hoop on an axis is left unclamped on that
 * axis -- clamping it would pin it in place and make it impossible to move at
 * all, which is worse than letting it overhang while it is being resized. */
function clampMoveToHoop(
  boxes: { minX: number; minY: number; maxX: number; maxY: number },
  dx: number,
  dy: number,
  hoopW: number,
  hoopH: number,
): { dx: number; dy: number } {
  const left = -hoopW / 2;
  const right = hoopW / 2;
  const top = -hoopH / 2;
  const bottom = hoopH / 2;
  let outX = dx;
  let outY = dy;
  if (boxes.maxX - boxes.minX <= hoopW) {
    if (boxes.minX + outX < left) outX = left - boxes.minX;
    if (boxes.maxX + outX > right) outX = right - boxes.maxX;
  }
  if (boxes.maxY - boxes.minY <= hoopH) {
    if (boxes.minY + outY < top) outY = top - boxes.minY;
    if (boxes.maxY + outY > bottom) outY = bottom - boxes.maxY;
  }
  return { dx: outX, dy: outY };
}

/** Nudges a move so the thing being dragged lands exactly on a guide when it is
 * already close to one. A guide you cannot snap to is just a drawn line; snapping
 * is what makes it square text and objects up. Each of the box's leading edge,
 * centre and trailing edge is a candidate, so a shape can be lined up by either
 * side or through the middle, and the closest candidate within the threshold
 * wins. */
function snapToGuides(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  dx: number,
  dy: number,
  guides: Guide[],
  toleranceMm: number,
): { dx: number; dy: number } {
  let outX = dx;
  let outY = dy;
  let bestX = toleranceMm;
  let bestY = toleranceMm;
  for (const g of guides) {
    if (g.axis === 'x') {
      for (const edge of [box.minX + dx, (box.minX + box.maxX) / 2 + dx, box.maxX + dx]) {
        const delta = g.mm - edge;
        if (Math.abs(delta) < bestX) {
          bestX = Math.abs(delta);
          outX = dx + delta;
        }
      }
    } else {
      for (const edge of [box.minY + dy, (box.minY + box.maxY) / 2 + dy, box.maxY + dy]) {
        const delta = g.mm - edge;
        if (Math.abs(delta) < bestY) {
          bestY = Math.abs(delta);
          outY = dy + delta;
        }
      }
    }
  }
  return { dx: outX, dy: outY };
}

/** Bounding box of a set of already-captured original point lists. */
function boundsOfPointLists(lists: Iterable<Point[]>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const list of lists) {
    for (const p of list) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** A 10mm grid across the hoop -- the increment embroidery is actually specified
 * in, so it doubles as a measuring aid. Every 50mm is drawn heavier and the two
 * centre axes heavier still, which is what makes it readable at a glance instead
 * of a uniform mesh. Skipped when zoomed far enough out that the lines would
 * merge into a solid tone. */
function drawHoopGrid(
  ctx: CanvasRenderingContext2D,
  toScreen: (p: Point) => Point,
  scale: number,
  hw: number,
  hh: number,
): void {
  const STEP = 10;
  if (STEP * scale < 6) return;
  const tl = toScreen({ x: -hw / 2, y: -hh / 2 });
  const br = toScreen({ x: hw / 2, y: hh / 2 });
  ctx.save();
  ctx.beginPath();
  ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.clip();
  ctx.lineWidth = 1;
  const line = (mm: number, vertical: boolean) => {
    const major = mm === 0;
    ctx.strokeStyle = major ? '#c6bfae' : Math.abs(mm) % 50 === 0 ? '#ded7c8' : '#eae5d9';
    ctx.beginPath();
    if (vertical) {
      const x = Math.round(toScreen({ x: mm, y: 0 }).x) + 0.5;
      ctx.moveTo(x, tl.y);
      ctx.lineTo(x, br.y);
    } else {
      const y = Math.round(toScreen({ x: 0, y: mm }).y) + 0.5;
      ctx.moveTo(tl.x, y);
      ctx.lineTo(br.x, y);
    }
    ctx.stroke();
  };
  const firstX = -Math.floor(hw / 2 / STEP) * STEP;
  for (let mm = firstX; mm <= hw / 2 + 1e-6; mm += STEP) line(mm, true);
  const firstY = -Math.floor(hh / 2 / STEP) * STEP;
  for (let mm = firstY; mm <= hh / 2 + 1e-6; mm += STEP) line(mm, false);
  ctx.restore();
}

/** Rulers down the top and left edges, marked in millimetres from the hoop
 * centre. Ticks every 10mm to match the grid; the labelled interval widens as
 * you zoom out so the numbers never collide. */
function drawRulers(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scale: number,
  panX: number,
  panY: number,
): void {
  const R = RULER_PX;
  const TICK = 10;
  const labelStep = [10, 20, 50, 100, 200, 500].find((mm) => mm * scale >= 42) ?? 1000;

  ctx.save();
  ctx.fillStyle = '#f6f3ea';
  ctx.fillRect(0, 0, w, R);
  ctx.fillRect(0, 0, R, h);
  ctx.strokeStyle = '#d5cfc0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, R + 0.5);
  ctx.lineTo(w, R + 0.5);
  ctx.moveTo(R + 0.5, 0);
  ctx.lineTo(R + 0.5, h);
  ctx.stroke();

  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#8b8371';
  ctx.strokeStyle = '#b8b1a1';

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const xFrom = Math.ceil((0 - panX) / scale / TICK) * TICK;
  const xTo = (w - panX) / scale;
  for (let mm = xFrom; mm <= xTo; mm += TICK) {
    const sx = Math.round(mm * scale + panX) + 0.5;
    if (sx < R) continue;
    const labelled = mm % labelStep === 0;
    ctx.beginPath();
    ctx.moveTo(sx, labelled ? 4 : R - 5);
    ctx.lineTo(sx, R);
    ctx.stroke();
    if (labelled) ctx.fillText(String(mm), sx + 2, 3);
  }

  const yFrom = Math.ceil((0 - panY) / scale / TICK) * TICK;
  const yTo = (h - panY) / scale;
  for (let mm = yFrom; mm <= yTo; mm += TICK) {
    const sy = Math.round(mm * scale + panY) + 0.5;
    if (sy < R) continue;
    const labelled = mm % labelStep === 0;
    ctx.beginPath();
    ctx.moveTo(labelled ? 4 : R - 5, sy);
    ctx.lineTo(R, sy);
    ctx.stroke();
    if (labelled) {
      // Rotated so the number reads along the ruler rather than spilling across it.
      ctx.save();
      ctx.translate(3, sy - 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'right';
      ctx.fillText(String(mm), 0, 0);
      ctx.restore();
      ctx.textAlign = 'left';
    }
  }

  // The corner square, so the two strips meet cleanly.
  ctx.fillStyle = '#efebe0';
  ctx.fillRect(0, 0, R, R);
  ctx.strokeStyle = '#d5cfc0';
  ctx.strokeRect(0.5, 0.5, R, R);
  ctx.restore();
}

function rgbCss(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export default function Canvas() {
  const { doc, dispatch, undo, redo, selectedId, setSelectedId, selectedIds, setSelectedIds, tool, activeColor, guideLineFor, setGuideLineFor, textFontKey, textSizeMm, textStitchStyle } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 3.5, panX: 0, panY: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const centeredRef = useRef(false);
  const [showStitchPreview, setShowStitchPreview] = useState(false);
  const [showCutMarkers, setShowCutMarkers] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<PathPoint[] | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const spaceDownRef = useRef(false);
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Where the caret sits and what has been typed so far. Non-null means a
  // typing session is live: keystrokes go to it rather than to the shortcuts.
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  const fontState = useTextFonts();
  const activeFont = useLoadedFont(textFontKey, fontState.fonts);

  // The letters are rebuilt from the font outlines on every keystroke, so what
  // is on the canvas while typing is exactly what gets committed -- no separate
  // preview representation that could drift from the real thing.
  const typedObjects = useMemo(() => {
    if (!typing || !activeFont || !typing.value) return [];
    try {
      return textToObjects({
        text: typing.value,
        font: activeFont,
        sizeMm: textSizeMm,
        x: typing.x,
        y: typing.y,
        color: activeColor,
        stitchStyle: textStitchStyle,
      });
    } catch {
      return [];
    }
  }, [typing, activeFont, textSizeMm, activeColor, textStitchStyle]);
  const dragRef = useRef<
    | { kind: 'pan'; startPx: Point; startPan: Point }
    | { kind: 'move-object'; id: string; startMm: Point; original: PathPoint[]; originalFill: FillParams | null }
    | { kind: 'move-multi'; ids: string[]; startMm: Point; originals: Map<string, PathPoint[]>; originalFills: Map<string, FillParams | null> }
    | { kind: 'move-vertex'; id: string; index: number }
    | { kind: 'move-endpoint'; id: string; which: 'start' | 'end' }
    | { kind: 'rect'; corner: Point; ellipse: boolean }
    | { kind: 'marquee'; corner: Point }
    | { kind: 'guide'; id: string; axis: 'x' | 'y'; isNew: boolean }
    | {
        kind: 'resize';
        handle: HandleDir;
        anchor: Point;
        startCorner: Point;
        originals: Map<string, PathPoint[]>;
        originalFills: Map<string, FillParams | null>;
      }
    | {
        kind: 'rotate';
        center: Point;
        startAngle: number;
        originals: Map<string, PathPoint[]>;
        originalFillAngles: Map<string, number>;
        originalFills: Map<string, FillParams | null>;
      }
    | null
  >(null);

  // Space-bar pan, matching the hold-to-pan convention of the other in-house apps.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || document.activeElement?.tagName === 'INPUT') return;
      e.preventDefault(); // stop the page from scrolling
      spaceDownRef.current = true;
      setSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceDownRef.current = false;
      setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Load the background template image whenever its source changes.
  useEffect(() => {
    if (!doc.background?.src) {
      setBgImg(null);
      return;
    }
    const img = new Image();
    img.onload = () => setBgImg(img);
    img.src = doc.background.src;
  }, [doc.background?.src]);

  // Only computed when the "Show cut points" toggle is on -- this walks the full
  // combined stitch sequence (same one the exporters use), so it's not free.
  const cutMarkerPattern = useMemo(
    () => (showCutMarkers ? buildPattern(doc.objects, doc.trimThresholdMm) : null),
    [showCutMarkers, doc.objects, doc.trimThresholdMm],
  );

  // Design-space union bounding box of the current selection, for the resize/rotate
  // handle frame. flattenPath (not the raw sparse points) so a curve that bulges
  // past its control points still gets a box that actually contains it.
  const selectionBBox = useMemo(() => {
    const selected = doc.objects.filter((o) => selectedIds.includes(o.id));
    if (selected.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of selected) {
      for (const p of flattenPath(o.points, o.kind === 'fill')) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }, [doc.objects, selectedIds]);

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

  // Fill objects can have an explicit start/end that's independent of the outline's
  // own point order (see fill.startPoint/endPoint) -- everywhere the marker actually
  // *is* needs to agree, so this is the one place that decides it: the override
  // when set, else the outline's first/last point same as every other kind.
  const getMarkerPositions = useCallback(
    (obj: EmbObject): { start: Point; end: Point; startIsExplicit: boolean; endIsExplicit: boolean } | null => {
      if (obj.points.length < 2) return null;
      if (obj.kind === 'fill') {
        return {
          start: obj.fill.startPoint ?? obj.points[0],
          end: obj.fill.endPoint ?? obj.points[obj.points.length - 1],
          startIsExplicit: obj.fill.startPoint != null,
          endIsExplicit: obj.fill.endPoint != null,
        };
      }
      return { start: obj.points[0], end: obj.points[obj.points.length - 1], startIsExplicit: true, endIsExplicit: true };
    },
    [],
  );

  // The start/end markers (green/red dots) sit exactly on the object's own first
  // and last point, same as two of its vertex handles — hit-tested with the same
  // radius so grabbing one among a dense cluster of ordinary vertices/stitch dots
  // still reliably lands on the marker, not a neighboring point.
  const getEndpointMarkerAt = useCallback(
    (p: Point, obj: EmbObject): 'start' | 'end' | null => {
      const markers = getMarkerPositions(obj);
      if (!markers) return null;
      const thresholdMm = VERTEX_HIT_PX / view.scale;
      if (Math.hypot(markers.start.x - p.x, markers.start.y - p.y) < thresholdMm) return 'start';
      if (Math.hypot(markers.end.x - p.x, markers.end.y - p.y) < thresholdMm) return 'end';
      return null;
    },
    [view.scale, getMarkerPositions],
  );

  const nearestVertexIndex = (p: Point, points: PathPoint[]): number => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  // Where a new point would land if the user chose "Add point here" for a right-click
  // that hit the object's outline but not an existing vertex — the raw (sparse)
  // points array, not the flattened curve, since that's what's actually edited.
  // A curved segment's flattened shape can bulge away from its two control points,
  // but hit-testing against the straight control-polygon segment is the same
  // "click near the outline to insert a node" convention most vector node-editors use.
  const getSegmentInsertIndex = useCallback(
    (p: Point, obj: EmbObject): number | null => {
      const pts = obj.points;
      if (pts.length < 2) return null;
      const closed = obj.kind === 'fill';
      const segCount = closed ? pts.length : pts.length - 1;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < segCount; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d = distanceToSegment(p, a, b);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      const thresholdMm = Math.max(OBJECT_HIT_PX / view.scale, obj.kind === 'satin' ? obj.satin.width / 2 : 0);
      return bestDist < thresholdMm ? best + 1 : null;
    },
    [view.scale],
  );

  const finishDrawing = useCallback(
    (cancel: boolean) => {
      if (guideLineFor) {
        if (drawingPoints && !cancel && drawingPoints.length >= 2) {
          const target = doc.objects.find((o) => o.id === guideLineFor);
          if (target && target.kind === 'fill') {
            dispatch({ type: 'UPDATE_OBJECT', id: guideLineFor, patch: { fill: { ...target.fill, guideLine: drawingPoints } } });
          }
        }
        setGuideLineFor(null);
        setDrawingPoints(null);
        return;
      }
      if (drawingPoints && !cancel && drawingPoints.length >= 2 && (tool === 'running' || tool === 'satin' || tool === 'fill')) {
        const obj = defaultObject(tool, drawingPoints, activeColor);
        dispatch({ type: 'ADD_OBJECT', object: obj });
        setSelectedId(obj.id);
      }
      setDrawingPoints(null);
    },
    [drawingPoints, tool, activeColor, dispatch, setSelectedId, guideLineFor, setGuideLineFor, doc.objects],
  );

  const commitTyping = useCallback(() => {
    if (typedObjects.length > 0) {
      dispatch({ type: 'ADD_OBJECTS', objects: typedObjects });
      setSelectedIds(typedObjects.map((o) => o.id));
    }
    setTyping(null);
  }, [typedObjects, dispatch, setSelectedIds]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const p = toDesign(px, py);

    // Pressing on a ruler pulls a new guide out of it, the way every design tool
    // does. The top ruler yields a horizontal guide (a fixed y), the left one a
    // vertical guide (a fixed x).
    if (px < RULER_PX || py < RULER_PX) {
      const axis: 'x' | 'y' = px < RULER_PX && py >= RULER_PX ? 'x' : 'y';
      const id = makeId();
      (e.target as Element).setPointerCapture(e.pointerId);
      dispatch({ type: 'ADD_GUIDE', guide: { id, axis, mm: axis === 'x' ? p.x : p.y } });
      dragRef.current = { kind: 'guide', id, axis, isNew: true };
      return;
    }

    // Grabbing an existing guide -- checked before objects so a guide lying over
    // a shape can still be picked up and moved.
    if (tool === 'select' && !guideLineFor) {
      const hitGuide = (doc.guides ?? []).find((g) => {
        const screen = g.axis === 'x' ? toScreen({ x: g.mm, y: 0 }).x : toScreen({ x: 0, y: g.mm }).y;
        return Math.abs((g.axis === 'x' ? px : py) - screen) <= 4;
      });
      if (hitGuide) {
        (e.target as Element).setPointerCapture(e.pointerId);
        dragRef.current = { kind: 'guide', id: hitGuide.id, axis: hitGuide.axis, isNew: false };
        return;
      }
    }

    // Drawing an angle guide line takes over the canvas completely, regardless
    // of whatever the normal tool is set to -- same click-to-place-vertex
    // mechanic as running/satin/fill (left = corner, right = curve), just
    // feeding the same drawingPoints state finishDrawing later attaches to
    // the target object's fill.guideLine instead of creating a new object.
    if (guideLineFor) {
      (e.target as Element).setPointerCapture(e.pointerId);
      const pt: PathPoint = { ...p, type: e.button === 2 ? 'curve' : 'corner' };
      setDrawingPoints((prev) => (prev ? [...prev, pt] : [pt]));
      return;
    }

    // Right-click in select mode opens a context menu instead of panning/drawing;
    // right-click while placing points (running/satin/fill) still means "curve point",
    // handled further down, so this only intercepts when there's a selection to act on.
    if (e.button === 2 && tool === 'select') {
      const selected = doc.objects.find((o) => o.id === selectedId);
      const vi = selected ? getVertexAt(p, selected) : -1;
      const hit = vi >= 0 ? selected! : getObjectAt(p);
      if (hit) {
        if (!selectedIds.includes(hit.id)) setSelectedId(hit.id);
        const insertIndex = vi < 0 ? getSegmentInsertIndex(p, hit) : null;
        setContextMenu({
          screenX: e.clientX,
          screenY: e.clientY,
          obj: hit,
          vertexIndex: vi >= 0 ? vi : null,
          insertIndex,
          insertPoint: insertIndex !== null ? p : null,
        });
      } else {
        setContextMenu(null);
      }
      return;
    }
    setContextMenu(null);
    (e.target as Element).setPointerCapture(e.pointerId);

    if (spaceDownRef.current || e.button === 1) {
      dragRef.current = { kind: 'pan', startPx: { x: px, y: py }, startPan: { x: view.panX, y: view.panY } };
      return;
    }

    if (tool === 'select') {
      // Resize/rotate handles take priority over everything else — they sit a fixed
      // number of screen px outside the selection's true content box (see
      // HANDLE_OUTSET_PX), so this can never collide with a vertex or object hit.
      if (selectionBBox && !doc.objects.filter((o) => selectedIds.includes(o.id)).some((o) => o.locked)) {
        const box: ScreenBox = {
          x0: toScreen({ x: selectionBBox.minX, y: selectionBBox.minY }).x - HANDLE_OUTSET_PX,
          y0: toScreen({ x: selectionBBox.minX, y: selectionBBox.minY }).y - HANDLE_OUTSET_PX,
          x1: toScreen({ x: selectionBBox.maxX, y: selectionBBox.maxY }).x + HANDLE_OUTSET_PX,
          y1: toScreen({ x: selectionBBox.maxX, y: selectionBBox.maxY }).y + HANDLE_OUTSET_PX,
        };
        const positions = handleScreenPositions(box);
        const rotateHandle = { x: (box.x0 + box.x1) / 2, y: box.y0 - ROTATE_OFFSET_PX };
        const originals = new Map(doc.objects.filter((o) => selectedIds.includes(o.id)).map((o) => [o.id, o.points.map((pt) => ({ ...pt }))]));
        const originalFillsFor = (ids: string[]) =>
          new Map(doc.objects.filter((o) => ids.includes(o.id)).map((o) => [o.id, o.kind === 'fill' ? o.fill : null]));

        if (Math.hypot(px - rotateHandle.x, py - rotateHandle.y) < HANDLE_HIT_PX) {
          const center = { x: (selectionBBox.minX + selectionBBox.maxX) / 2, y: (selectionBBox.minY + selectionBBox.maxY) / 2 };
          const originalFillAngles = new Map(
            doc.objects.filter((o) => selectedIds.includes(o.id) && o.kind === 'fill').map((o) => [o.id, o.fill.angle]),
          );
          dragRef.current = {
            kind: 'rotate',
            center,
            startAngle: Math.atan2(p.y - center.y, p.x - center.x),
            originals,
            originalFillAngles,
            originalFills: originalFillsFor(selectedIds),
          };
          return;
        }
        for (const dir of HANDLE_DIRS) {
          const hp = positions[dir];
          if (Math.hypot(px - hp.x, py - hp.y) < HANDLE_HIT_PX) {
            const anchorDir: HandleDir = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' }[dir] as HandleDir;
            const cornerOf = (d: HandleDir): Point => ({
              x: d.includes('w') ? selectionBBox.minX : d.includes('e') ? selectionBBox.maxX : (selectionBBox.minX + selectionBBox.maxX) / 2,
              y: d.includes('n') ? selectionBBox.minY : d.includes('s') ? selectionBBox.maxY : (selectionBBox.minY + selectionBBox.maxY) / 2,
            });
            dragRef.current = {
              kind: 'resize',
              handle: dir,
              anchor: cornerOf(anchorDir),
              startCorner: cornerOf(dir),
              originals,
              originalFills: originalFillsFor(selectedIds),
            };
            return;
          }
        }
      }

      const selected = doc.objects.find((o) => o.id === selectedId);
      if (selected && !selected.locked) {
        // Checked before the general vertex hit-test: start/end markers sit
        // exactly on top of the first/last vertex, and dragging one means "make
        // this vertex the start/end" (a live version of the same context-menu
        // actions), not "move this point's position" like an ordinary vertex drag.
        const marker = getEndpointMarkerAt(p, selected);
        if (marker) {
          dragRef.current = { kind: 'move-endpoint', id: selected.id, which: marker };
          return;
        }
        const vi = getVertexAt(p, selected);
        if (vi >= 0) {
          dragRef.current = { kind: 'move-vertex', id: selected.id, index: vi };
          return;
        }
      }
      const hit = getObjectAt(p);
      if (hit) {
        // Clicking any member of a group picks up the whole group -- that is
        // what grouping is for -- and the existing multi-move drag then carries
        // them together.
        const mates = hit.groupId ? doc.objects.filter((o) => o.groupId === hit.groupId) : [];
        if (mates.length > 1 && !(selectedIds.length > 1 && selectedIds.includes(hit.id))) {
          const ids = mates.map((o) => o.id);
          setSelectedIds(ids);
          const movable = mates.filter((o) => !o.locked);
          if (movable.length > 0) {
            dragRef.current = {
              kind: 'move-multi',
              ids: movable.map((o) => o.id),
              startMm: p,
              originals: new Map(movable.map((o) => [o.id, o.points.map((pt) => ({ ...pt }))])),
              originalFills: new Map(movable.map((o) => [o.id, o.kind === 'fill' ? o.fill : null])),
            };
          }
          return;
        }
        if (selectedIds.length > 1 && selectedIds.includes(hit.id)) {
          // dragging one of an existing multi-selection moves the whole group
          const originals = new Map(doc.objects.filter((o) => selectedIds.includes(o.id)).map((o) => [o.id, o.points.map((pt) => ({ ...pt }))]));
          const originalFills = new Map(doc.objects.filter((o) => selectedIds.includes(o.id)).map((o) => [o.id, o.kind === 'fill' ? o.fill : null]));
          dragRef.current = { kind: 'move-multi', ids: selectedIds, startMm: p, originals, originalFills };
          return;
        }
        setSelectedId(hit.id);
        if (!hit.locked)
          dragRef.current = {
            kind: 'move-object',
            id: hit.id,
            startMm: p,
            original: hit.points.map((pt) => ({ ...pt })),
            originalFill: hit.kind === 'fill' ? hit.fill : null,
          };
        return;
      }
      setSelectedIds([]);
      // empty space in select mode: drag to marquee-select multiple objects
      dragRef.current = { kind: 'marquee', corner: p };
      return;
    }

    if (tool === 'text') {
      // Clicking elsewhere while typing finishes the current word and starts a
      // fresh one at the new spot, which is how every other text tool behaves.
      if (typing) commitTyping();
      setTyping({ x: p.x, y: p.y, value: '' });
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

    if (drag.kind === 'guide') {
      dispatch({ type: 'MOVE_GUIDE', id: drag.id, mm: drag.axis === 'x' ? p.x : p.y });
      return;
    }
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, panX: drag.startPan.x + (px - drag.startPx.x), panY: drag.startPan.y + (py - drag.startPx.y) }));
    } else if (drag.kind === 'move-object') {
      const box = boundsOfPointLists([drag.original]);
      const snapped = snapToGuides(box, p.x - drag.startMm.x, p.y - drag.startMm.y, doc.guides ?? [], SNAP_MM / view.scale);
      const { dx, dy } = clampMoveToHoop(box, snapped.dx, snapped.dy, doc.hoop.width, doc.hoop.height);
      const translate = (pt: Point) => ({ x: pt.x + dx, y: pt.y + dy });
      const patch: Partial<EmbObject> = { points: drag.original.map((pt) => ({ ...translate(pt), type: pt.type })) };
      if (drag.originalFill) patch.fill = transformFillAnchors(drag.originalFill, translate);
      dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch });
    } else if (drag.kind === 'move-vertex') {
      const obj = doc.objects.find((o) => o.id === drag.id);
      if (obj) {
        const pts = obj.points.map((pt, i) => (i === drag.index ? { ...p, type: pt.type } : pt));
        dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch: { points: pts } });
      }
    } else if (drag.kind === 'move-endpoint') {
      const obj = doc.objects.find((o) => o.id === drag.id);
      if (obj) {
        const pts = obj.points;
        const n = pts.length;
        if (obj.kind === 'fill') {
          // Fully independent: either marker can land on any vertex, including
          // the same one the other marker is already on ("start and stop at the
          // same point"), unlike an open path where the two ends are fixed. The
          // engine bridges from wherever the fill's own scan naturally starts/
          // ends to this exact point, walking the shape's edge (see fillStitches),
          // so this is a real target position, not just a hint.
          const targetIndex = nearestVertexIndex(p, pts);
          const target = { x: pts[targetIndex].x, y: pts[targetIndex].y };
          const patch = drag.which === 'start' ? { startPoint: target } : { endPoint: target };
          dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch: { fill: { ...obj.fill, ...patch } } });
        } else {
          // An open path's point order *is* its shape -- only the two actual
          // endpoints are valid start/end positions. Dragging past the midpoint
          // toward the other end reverses the path (same as "Reverse direction");
          // dragging back snaps right back, since there's nowhere else to land.
          const distToStart = Math.hypot(pts[0].x - p.x, pts[0].y - p.y);
          const distToEnd = Math.hypot(pts[n - 1].x - p.x, pts[n - 1].y - p.y);
          const nearEnd = distToEnd < distToStart;
          const shouldBeReversed = drag.which === 'start' ? nearEnd : !nearEnd;
          if (shouldBeReversed) dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch: { points: [...pts].reverse() } });
        }
      }
    } else if (drag.kind === 'rect') {
      const target = e.shiftKey ? constrainToSquare(drag.corner, p) : p;
      setDrawingPoints(rectPoints(drag.corner, target, drag.ellipse));
    } else if (drag.kind === 'move-multi') {
      // One clamp for the whole selection's combined box, so a group keeps its
      // internal spacing instead of individual members piling up on the edge.
      const box = boundsOfPointLists(drag.originals.values());
      const snapped = snapToGuides(box, p.x - drag.startMm.x, p.y - drag.startMm.y, doc.guides ?? [], SNAP_MM / view.scale);
      const { dx, dy } = clampMoveToHoop(box, snapped.dx, snapped.dy, doc.hoop.width, doc.hoop.height);
      const translate = (pt: Point) => ({ x: pt.x + dx, y: pt.y + dy });
      for (const id of drag.ids) {
        const original = drag.originals.get(id);
        if (!original) continue;
        const patch: Partial<EmbObject> = { points: original.map((pt) => ({ ...translate(pt), type: pt.type })) };
        const originalFill = drag.originalFills.get(id);
        if (originalFill) patch.fill = transformFillAnchors(originalFill, translate);
        dispatch({ type: 'UPDATE_OBJECT', id, patch });
      }
    } else if (drag.kind === 'resize') {
      const { anchor, startCorner, handle } = drag;
      // A degenerate axis (e.g. dragging the S handle on a perfectly horizontal
      // line, whose original height is 0) has no ratio to preserve — leave that
      // axis alone rather than divide by ~0.
      const scaleFor = (curr: number, start: number, anch: number) => {
        const span = start - anch;
        if (Math.abs(span) < 1e-6) return 1;
        return Math.max(0.05, (curr - anch) / span);
      };
      const scaleX = handle === 'n' || handle === 's' ? 1 : scaleFor(p.x, startCorner.x, anchor.x);
      const scaleY = handle === 'e' || handle === 'w' ? 1 : scaleFor(p.y, startCorner.y, anchor.y);
      const scalePt = (pt: Point) => ({ x: anchor.x + (pt.x - anchor.x) * scaleX, y: anchor.y + (pt.y - anchor.y) * scaleY });
      for (const [id, original] of drag.originals) {
        const patch: Partial<EmbObject> = { points: original.map((pt) => ({ ...scalePt(pt), type: pt.type })) };
        const originalFill = drag.originalFills.get(id);
        if (originalFill) patch.fill = transformFillAnchors(originalFill, scalePt);
        dispatch({ type: 'UPDATE_OBJECT', id, patch });
      }
    } else if (drag.kind === 'rotate') {
      const angle = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
      let deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
      if (e.shiftKey) deltaDeg = Math.round(deltaDeg / 15) * 15;
      const rotatePt = (pt: Point) => rotatePoint(pt, drag.center, deltaDeg);
      for (const [id, original] of drag.originals) {
        const obj = doc.objects.find((o) => o.id === id);
        // A fill's row angle is independent of its outline points, so rotating
        // the shape without also rotating this leaves the tatami rows pointed the
        // old direction relative to the now-turned edges -- rows land diagonally
        // across a rotated square instead of parallel to its sides, producing a
        // ragged, not-flush edge instead of the ends lining up on the boundary.
        // Its start/end/guide anchors need the same rotation for the same reason
        // start/end markers are absolute coordinates, not tied to point order.
        const originalFillAngle = drag.originalFillAngles.get(id);
        const originalFill = drag.originalFills.get(id);
        const patch: Partial<EmbObject> = {
          points: original.map((pt) => ({ ...rotatePt(pt), type: pt.type })),
        };
        if (obj && obj.kind === 'fill' && originalFillAngle !== undefined && originalFill) {
          patch.fill = { ...transformFillAnchors(originalFill, rotatePt), angle: originalFillAngle + deltaDeg };
        }
        dispatch({ type: 'UPDATE_OBJECT', id, patch });
      }
    }
    // 'marquee' needs no per-move work: the rectangle is rendered live from
    // drag.corner + mousePos (already updated above), and resolved at pointer-up.
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;

    // Dropping a guide back onto a ruler, or outside the hoop entirely, throws
    // it away -- the same gesture that created it, reversed.
    if (drag?.kind === 'guide') {
      const rect = canvasRef.current!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const g = (doc.guides ?? []).find((x) => x.id === drag.id);
      const limit = drag.axis === 'x' ? doc.hoop.width / 2 : doc.hoop.height / 2;
      if (px < RULER_PX || py < RULER_PX || !g || Math.abs(g.mm) > limit + 2) {
        dispatch({ type: 'REMOVE_GUIDE', id: drag.id });
      }
      dragRef.current = null;
      return;
    }

    // A "move-endpoint" drag only actually sets fill.startPoint/endPoint from
    // inside onPointerMove -- so a plain click with no real mouse movement
    // (grabbing a marker that's already sitting right where the user wants it,
    // which is exactly the common case: it's on the fallback vertex already)
    // never fires a single pointermove and never commits anything. The marker
    // stays hollow/unset with no feedback that the click "did nothing" at all.
    // Explicitly commit to the marker's current (fallback) position here if a
    // move-endpoint drag ends without ever having set an explicit value.
    if (drag?.kind === 'move-endpoint') {
      const obj = doc.objects.find((o) => o.id === drag.id);
      if (obj && obj.kind === 'fill') {
        const isSet = drag.which === 'start' ? obj.fill.startPoint != null : obj.fill.endPoint != null;
        if (!isSet) {
          const fallback = drag.which === 'start' ? obj.points[0] : obj.points[obj.points.length - 1];
          const patch = drag.which === 'start' ? { startPoint: { x: fallback.x, y: fallback.y } } : { endPoint: { x: fallback.x, y: fallback.y } };
          dispatch({ type: 'UPDATE_OBJECT', id: drag.id, patch: { fill: { ...obj.fill, ...patch } } });
        }
      }
    }
    if (drag?.kind === 'marquee') {
      // Compute the release point straight from this event rather than trusting the
      // `mousePos` state: a fast drag can fire pointerup before React has re-rendered
      // with the last pointermove's setMousePos, leaving mousePos one frame stale and
      // silently shrinking the marquee to whatever it was before the final move.
      const rect = canvasRef.current!.getBoundingClientRect();
      const end = toDesign(e.clientX - rect.left, e.clientY - rect.top);
      const minX = Math.min(drag.corner.x, end.x);
      const maxX = Math.max(drag.corner.x, end.x);
      const minY = Math.min(drag.corner.y, end.y);
      const maxY = Math.max(drag.corner.y, end.y);
      const touchesMarquee = (o: EmbObject) => o.points.some((pt) => pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY);
      const matched = doc.objects.filter((o) => o.visible && !o.locked && touchesMarquee(o)).map((o) => o.id);
      setSelectedIds(matched);
    }
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
      const typingInField = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';

      // A live typing session owns the keyboard: every printable key is text,
      // not a shortcut. Checked before anything else so 'd', 't' and the rest
      // type normally instead of toggling the background or stitch preview.
      if (typing && !typingInField) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setTyping(null);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTyping();
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          setTyping((t) => (t ? { ...t, value: t.value.slice(0, -1) } : t));
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setTyping((t) => (t ? { ...t, value: t.value + e.key } : t));
          return;
        }
        return;
      }

      if (e.key === 'Enter') finishDrawing(false);
      if (e.key === 'Escape') finishDrawing(true);

      if (typingInField) return; // let the field's own native editing (including its own Backspace/Ctrl+Z) happen

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault(); // otherwise the browser tries to bookmark the page
        if (selectedIds.length > 0) {
          const newIds = selectedIds.map((id) => {
            const newId = makeId();
            dispatch({ type: 'DUPLICATE_OBJECT', id, newId });
            return newId;
          });
          setSelectedIds(newIds);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) dispatch({ type: 'UNGROUP_OBJECTS', ids: selectedIds });
        else if (selectedIds.length > 1) dispatch({ type: 'GROUP_OBJECTS', ids: selectedIds, groupId: makeId() });
        return;
      }

      if (e.key === 'Delete') {
        for (const id of selectedIds) dispatch({ type: 'REMOVE_OBJECT', id });
        if (selectedIds.length > 0) setSelectedIds([]);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault(); // otherwise some browsers treat it as "navigate back"
        if (drawingPoints && drawingPoints.length > 0) {
          setDrawingPoints((prev) => (prev && prev.length > 1 ? prev.slice(0, -1) : null));
        }
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        dispatch({ type: 'UPDATE_BACKGROUND', patch: { visible: !doc.background?.visible } });
      }
      if (e.key === 't' || e.key === 'T') {
        setShowStitchPreview((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishDrawing, selectedId, dispatch, setSelectedId, selectedIds, setSelectedIds, doc.background?.visible, drawingPoints, undo, redo, typing, commitTyping]);

  // Attached as a native, non-passive listener (not the JSX onWheel prop) —
  // React registers wheel/touch handlers passively by default for scroll
  // perf, and calling preventDefault() inside a passive listener is a no-op
  // that also logs a console warning every time.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const before = toDesign(px, py);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newScale = Math.min(40, Math.max(0.6, view.scale * factor));
      const newPanX = px - before.x * newScale;
      const newPanY = py - before.y * newScale;
      setView({ scale: newScale, panX: newPanX, panY: newPanY });
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [view, toDesign]);

  // Belt-and-suspenders alongside the JSX onContextMenu prop below: some browsers/
  // input combos (right-click via a trackpad gesture, certain Chrome extensions
  // injecting their own context menu) can still show the native menu even when a
  // React synthetic contextmenu handler calls preventDefault(), the same class of
  // gap the wheel handler above had. A native listener is more reliably respected.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener('contextmenu', handler);
    return () => canvas.removeEventListener('contextmenu', handler);
  }, []);

  const activeDrag = dragRef.current;
  const selectedForHover = tool === 'select' ? doc.objects.find((o) => o.id === selectedId) : undefined;
  // Hover feedback (not just while dragging): a start/end marker sits exactly on
  // top of an ordinary vertex among what can be hundreds of dense stitch/point
  // markers, so confirming "yes, this is the marker" before committing to a drag
  // matters a lot more here than it would for a normal, larger UI target.
  const hoveredEndpoint =
    !activeDrag && selectedForHover && !selectedForHover.locked && mousePos ? getEndpointMarkerAt(mousePos, selectedForHover) : null;

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

    // canvas backdrop
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

    drawHoopGrid(ctx, toScreen, view.scale, hw, hh);

    for (const g of doc.guides ?? []) {
      const at = g.axis === 'x' ? toScreen({ x: g.mm, y: 0 }).x : toScreen({ x: 0, y: g.mm }).y;
      ctx.strokeStyle = '#12a3c4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (g.axis === 'x') {
        ctx.moveTo(Math.round(at) + 0.5, RULER_PX);
        ctx.lineTo(Math.round(at) + 0.5, h);
      } else {
        ctx.moveTo(RULER_PX, Math.round(at) + 0.5);
        ctx.lineTo(w, Math.round(at) + 0.5);
      }
      ctx.stroke();
    }

    // background template image (traced over, toggled with D)
    if (doc.background?.visible && bgImg) {
      const bg = doc.background;
      const bgTopLeft = toScreen({ x: bg.x - bg.width / 2, y: bg.y - bg.height / 2 });
      ctx.save();
      ctx.globalAlpha = bg.opacity;
      ctx.drawImage(bgImg, bgTopLeft.x, bgTopLeft.y, bg.width * view.scale, bg.height * view.scale);
      ctx.restore();
    }

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
      drawObject(ctx, obj, toScreen, view.scale, selectedIds.includes(obj.id), showStitchPreview);
    }

    // Resize/rotate handle frame around the current selection — not while actively
    // drawing a new shape, and not for a locked object (nothing to transform).
    if (
      tool === 'select' &&
      selectionBBox &&
      !drawingPoints &&
      !doc.objects.filter((o) => selectedIds.includes(o.id)).some((o) => o.locked)
    ) {
      const box: ScreenBox = {
        x0: toScreen({ x: selectionBBox.minX, y: selectionBBox.minY }).x - HANDLE_OUTSET_PX,
        y0: toScreen({ x: selectionBBox.minX, y: selectionBBox.minY }).y - HANDLE_OUTSET_PX,
        x1: toScreen({ x: selectionBBox.maxX, y: selectionBBox.maxY }).x + HANDLE_OUTSET_PX,
        y1: toScreen({ x: selectionBBox.maxX, y: selectionBBox.maxY }).y + HANDLE_OUTSET_PX,
      };
      ctx.strokeStyle = '#2f6fed';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.setLineDash([]);

      const positions = handleScreenPositions(box);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2f6fed';
      ctx.lineWidth = 1.5;
      for (const dir of HANDLE_DIRS) {
        const hp = positions[dir];
        ctx.fillRect(hp.x - 4, hp.y - 4, 8, 8);
        ctx.strokeRect(hp.x - 4, hp.y - 4, 8, 8);
      }

      const mx = (box.x0 + box.x1) / 2;
      const rotateY = box.y0 - ROTATE_OFFSET_PX;
      ctx.beginPath();
      ctx.moveTo(mx, box.y0);
      ctx.lineTo(mx, rotateY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, rotateY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    }

    // A saved angle guide line on the selected fill object -- drawn as a
    // dashed teal path so it reads distinctly from the object's own outline
    // (blue, when selected) and from the running stitch-preview stitches.
    const selectedForGuide = doc.objects.find((o) => o.id === selectedId);
    if (selectedForGuide?.kind === 'fill' && selectedForGuide.fill.guideLine && selectedForGuide.fill.guideLine.length >= 2) {
      const flat = flattenPath(selectedForGuide.fill.guideLine, false);
      ctx.beginPath();
      flat.forEach((p, i) => {
        const sp = toScreen(p);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.strokeStyle = '#0aa89e';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (cutMarkerPattern) drawCutMarkers(ctx, cutMarkerPattern.stitches, toScreen);

    // Draggable start (green) / end (red) markers for the primary selection —
    // grab and drop on any vertex to reassign which point the thread starts/ends
    // at, live. Slightly larger than an ordinary vertex handle and outlined in
    // white so they read as distinct targets even sitting on top of a dense
    // cluster of vertex/stitch dots. Drawn *after* the cut markers (scissors) so a
    // start/end that happens to land right at a trim is never hidden underneath one.
    if (tool === 'select' && !drawingPoints) {
      const selectedObj = doc.objects.find((o) => o.id === selectedId);
      const markers = selectedObj && selectedObj.visible ? getMarkerPositions(selectedObj) : null;
      if (markers) {
        const startPt = toScreen(markers.start);
        const endPt = toScreen(markers.end);
        // A fill's start/end marker that hasn't actually been set yet (fill.startPoint/
        // endPoint still null) renders at the outline's own first/last point as a
        // fallback -- indistinguishable at a glance from a marker the user actually
        // dragged there, which reads as "start is set at this corner" when really the
        // engine still treats it as unset and falls back to a plain single scan
        // instead of the two-region split technique. Drawn hollow (ring only, no
        // fill) instead of solid to make that distinction visible.
        const drawMarker = (pt: Point, color: string, hovered: boolean, isExplicit: boolean) => {
          const r = hovered ? 7 : 5.5;
          // A solid white "halo" behind the marker itself, a couple px larger, so it
          // reads clearly against ANY fill color -- including a red end marker sitting
          // on the user's own red-filled shape, where the marker used to all but
          // disappear into the fill and made "is this actually set" impossible to
          // tell just by looking, regardless of whether it actually was.
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r + 2.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          if (isExplicit) {
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.5;
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
          }
          ctx.stroke();
        };
        drawMarker(endPt, '#c0392b', hoveredEndpoint === 'end', markers.endIsExplicit);
        drawMarker(startPt, '#2e9e4f', hoveredEndpoint === 'start', markers.startIsExplicit);
      }
    }

    // marquee-select rectangle, live while dragging
    if (dragRef.current?.kind === 'marquee' && mousePos) {
      const a = toScreen(dragRef.current.corner);
      const b = toScreen(mousePos);
      ctx.strokeStyle = '#2f6fed';
      ctx.fillStyle = 'rgba(47, 111, 237, 0.08)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w2 = Math.abs(b.x - a.x);
      const h2 = Math.abs(b.y - a.y);
      ctx.fillRect(x, y, w2, h2);
      ctx.strokeRect(x, y, w2, h2);
      ctx.setLineDash([]);
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

    // Lettering being typed right now, drawn exactly like a real object so what
    // you see is what gets committed, plus a caret at the baseline so an empty
    // session still shows where the text will land.
    if (typing) {
      for (const obj of typedObjects) drawObject(ctx, obj, toScreen, view.scale, false, showStitchPreview);
      const caretBase = toScreen({ x: typing.x, y: typing.y });
      const lastX = typedObjects.length
        ? Math.max(...typedObjects.flatMap((o) => o.points.map((pt) => pt.x)))
        : typing.x;
      const caretX = toScreen({ x: lastX, y: typing.y }).x + 2;
      ctx.strokeStyle = '#2f6fed';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(caretX, caretBase.y + textSizeMm * 0.22 * view.scale);
      ctx.lineTo(caretX, caretBase.y - textSizeMm * 0.78 * view.scale);
      ctx.stroke();
    }

    // Last, so the rulers stay legible over whatever the design puts near the
    // top-left corner.
    drawRulers(ctx, w, h, view.scale, view.panX, view.panY);
  }, [doc, view, size, selectedIds, selectedId, showStitchPreview, drawingPoints, mousePos, toScreen, bgImg, cutMarkerPattern, tool, selectionBBox, hoveredEndpoint, getMarkerPositions, typing, typedObjects, textSizeMm]);

  const cursor = spaceDown
    ? activeDrag?.kind === 'pan'
      ? 'grabbing'
      : 'grab'
    : activeDrag?.kind === 'resize'
      ? RESIZE_CURSORS[activeDrag.handle]
      : activeDrag?.kind === 'rotate'
        ? 'grabbing'
        : activeDrag?.kind === 'move-endpoint' || hoveredEndpoint
          ? 'pointer'
          : undefined;

  return (
    <div className="canvas-wrap" ref={containerRef}>
      <canvas
        ref={canvasRef}
        style={cursor ? { cursor } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {tool === 'text' && <TextToolBar {...fontState} />}
      <div className="canvas-hint">
        {spaceDown
          ? 'Drag to pan'
          : tool === 'text'
            ? typing
              ? 'Type to add letters · Enter to place · Esc to cancel · click elsewhere to start another'
              : 'Click in the hoop where the text should start, then type'
            : tool === 'select'
            ? 'Click to select · drag empty space to multi-select · right-click for options · Delete to remove'
            : tool === 'rect' || tool === 'ellipse'
              ? 'Drag to draw the shape · hold Shift to keep it square/circular'
              : 'Left-click = corner point (▪) · right-click = curve point (●) · double-click or Enter to finish · Esc to cancel'}
      </div>
      <div className="canvas-controls">
        <BackgroundControls />
        <label>
          <input type="checkbox" checked={showStitchPreview} onChange={(e) => setShowStitchPreview(e.target.checked)} />
          Stitch preview <span className="muted">(T)</span>
        </label>
        <label>
          <input type="checkbox" checked={showCutMarkers} onChange={(e) => setShowCutMarkers(e.target.checked)} />
          Cut points
        </label>
        <div className="zoom-controls">
          <button onClick={() => setView((v) => ({ ...v, scale: Math.max(0.6, v.scale / 1.2) }))}>−</button>
          <input
            className="zoom-input"
            type="number"
            value={Math.round(view.scale * 10)}
            min={6}
            max={400}
            onChange={(e) => {
              const pct = parseFloat(e.target.value);
              if (!Number.isNaN(pct)) setView((v) => ({ ...v, scale: Math.min(40, Math.max(0.6, pct / 10)) }));
            }}
          />
          <span className="zoom-percent-sign">%</span>
          <button onClick={() => setView((v) => ({ ...v, scale: Math.min(40, v.scale * 1.2) }))}>+</button>
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onDuplicate={() => {
            const newId = makeId();
            dispatch({ type: 'DUPLICATE_OBJECT', id: contextMenu.obj.id, newId });
            setSelectedId(newId);
          }}
          onDelete={() => {
            dispatch({ type: 'REMOVE_OBJECT', id: contextMenu.obj.id });
            setSelectedIds([]);
          }}
          canGroup={selectedIds.length > 1}
          canUngroup={!!contextMenu.obj.groupId}
          onGroup={() => dispatch({ type: 'GROUP_OBJECTS', ids: selectedIds, groupId: makeId() })}
          onUngroup={() => dispatch({ type: 'UNGROUP_OBJECTS', ids: [contextMenu.obj.id] })}
          onToggleLock={() => dispatch({ type: 'UPDATE_OBJECT', id: contextMenu.obj.id, patch: { locked: !contextMenu.obj.locked } })}
          onToggleVisible={() => dispatch({ type: 'UPDATE_OBJECT', id: contextMenu.obj.id, patch: { visible: !contextMenu.obj.visible } })}
          onConvertKind={(kind) =>
            dispatch({
              type: 'UPDATE_OBJECT',
              id: contextMenu.obj.id,
              patch: { kind, points: pointsForKindChange(contextMenu.obj.kind, kind, contextMenu.obj.points) },
            })
          }
          onSetStartPoint={(vertexIndex) => {
            // Same explicit-point mechanism the draggable marker uses (see
            // fillStitches' start bridge) -- not a rotation, since rotating the
            // outline doesn't actually change where the row-scan begins.
            const v = contextMenu.obj.points[vertexIndex];
            dispatch({
              type: 'UPDATE_OBJECT',
              id: contextMenu.obj.id,
              patch: { fill: { ...contextMenu.obj.fill, startPoint: { x: v.x, y: v.y } } },
            });
          }}
          onSetEndPoint={(vertexIndex) => {
            const v = contextMenu.obj.points[vertexIndex];
            dispatch({
              type: 'UPDATE_OBJECT',
              id: contextMenu.obj.id,
              patch: { fill: { ...contextMenu.obj.fill, endPoint: { x: v.x, y: v.y } } },
            });
          }}
          onReverseDirection={() => {
            const reversed = [...contextMenu.obj.points].reverse();
            dispatch({ type: 'UPDATE_OBJECT', id: contextMenu.obj.id, patch: { points: reversed } });
          }}
          onAddPoint={(insertIndex, point) => {
            const pts = contextMenu.obj.points.slice();
            pts.splice(insertIndex, 0, { ...point, type: 'corner' });
            dispatch({ type: 'UPDATE_OBJECT', id: contextMenu.obj.id, patch: { points: pts } });
          }}
          onDeletePoint={(vertexIndex) => {
            const pts = contextMenu.obj.points.filter((_, i) => i !== vertexIndex);
            dispatch({ type: 'UPDATE_OBJECT', id: contextMenu.obj.id, patch: { points: pts } });
          }}
        />
      )}
    </div>
  );
}

/** Marks every TRIM (thread cut) in the combined stitch sequence with a small scissor
 * glyph, so it's visible on the canvas where a cut will happen before ever exporting
 * or opening the stitch-out preview. The design's overall first/last stitch used to
 * get its own green/red dot here too, but that's the same thing the per-object start/
 * end markers already show (drawn separately, right below, whenever an object is
 * selected) — having both up at once just put two overlapping dots of each color at
 * the same spot, which is what this comment used to *not* warn about. */
function drawCutMarkers(ctx: CanvasRenderingContext2D, stitches: StitchPoint[], toScreen: (p: Point) => Point) {
  for (const s of stitches) {
    if (s.command !== 'TRIM') continue;
    const p = toScreen(s);
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#c0392b';
    ctx.fillText('✂', p.x, p.y + 0.5);
  }
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
      const lineW = Math.max(1, scale * 0.28);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      const first = toScreen(stitches[0]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stitches.length; i++) {
        const s = toScreen(stitches[i]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      // Individual needle-penetration dots — without these, stitches along a
      // straight tatami row are invisible as a stroked line (collinear points
      // look identical whether staggered row-to-row or not), which hid the fill
      // stagger entirely. Sized to always poke out past the stroke's own width
      // (which grows with zoom just like these do) rather than a fixed radius,
      // or a thick zoomed-in line completely swallows them. Only drawn zoomed-in
      // enough to read as dots rather than a blur, both for legibility and
      // because a dense fill can be thousands of stitches.
      if (scale >= 6) {
        const r = lineW / 2 + 1.4;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        for (const sp of stitches) {
          const s = toScreen(sp);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
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
    // A letter is one satin object holding several columns end to end, so the
    // path has to be broken where one column stops and the next starts --
    // drawing straight through would put a bogus stroke across the letter
    // between, say, the bar of an "A" and its next leg.
    const breaks = obj.kind === 'satin' ? (obj.satin.columnBreaks ?? []) : [];
    const bounds = [0, ...breaks.filter((b) => b > 0 && b < obj.points.length), obj.points.length];
    const widths = obj.kind === 'satin' ? obj.satin.columnWidths : undefined;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let c = 0; c + 1 < bounds.length; c++) {
      const slice = obj.points.slice(bounds[c], bounds[c + 1]);
      if (slice.length < 2) continue;
      const flat = flattenPath(slice, false);
      const w = obj.kind === 'satin' ? (widths?.[c] ?? obj.satin.width) : 0;
      ctx.strokeStyle = color;
      ctx.lineWidth = obj.kind === 'satin' ? Math.max(2, w * scale) : 2;
      ctx.globalAlpha = obj.kind === 'satin' ? 0.5 : 1;
      ctx.beginPath();
      const first = toScreen(flat[0]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < flat.length; i++) {
        const sp = toScreen(flat[i]);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (obj.kind === 'satin') {
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  if (selected) {
    for (const p of obj.points) drawVertexMarker(ctx, toScreen(p), p.type, '#2f6fed', '#ffffff');
  }
}
