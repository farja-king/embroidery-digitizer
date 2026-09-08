import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackgroundImage, Document, EmbObject, HoopSize, PathPoint, RGB, StitchKind, ToolId } from '../types';
import { HOOP_PRESETS, defaultTwoPassUnderlay } from '../types';
import { flattenPath } from '../stitching/geometry';

export type AlignMode = 'left' | 'right' | 'centerH' | 'top' | 'bottom' | 'centerV';

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultObject(kind: StitchKind, points: PathPoint[], color: RGB): EmbObject {
  return {
    id: makeId(),
    kind,
    name: kind[0].toUpperCase() + kind.slice(1),
    points,
    color,
    visible: true,
    locked: false,
    running: { stitchLength: 2.5, triple: false },
    satin: { width: 3, density: 0.4, underlay: defaultTwoPassUnderlay('zigzag'), pullCompensation: 0.2 },
    fill: {
      angle: 0,
      rowSpacing: 0.4,
      stitchLength: 3,
      underlay: defaultTwoPassUnderlay('tatami'),
      pullCompensation: 0.3,
      startPoint: null,
      endPoint: null,
      bridgeMode: 'perimeter',
    },
  };
}

const initialDocument: Document = {
  name: 'Untitled Design',
  hoop: HOOP_PRESETS[0],
  objects: [],
  background: null,
  trimThresholdMm: 3,
};

type Action =
  | { type: 'ADD_OBJECT'; object: EmbObject }
  | { type: 'UPDATE_OBJECT'; id: string; patch: Partial<EmbObject> }
  | { type: 'REMOVE_OBJECT'; id: string }
  | { type: 'DUPLICATE_OBJECT'; id: string; newId: string }
  | { type: 'REORDER'; fromIndex: number; toIndex: number }
  | { type: 'ALIGN_OBJECTS'; ids: string[]; mode: AlignMode }
  | { type: 'OPTIMIZE_STITCH_ORDER' }
  | { type: 'SET_HOOP'; hoop: HoopSize }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_TRIM_THRESHOLD'; mm: number }
  | { type: 'SET_BACKGROUND'; background: BackgroundImage | null }
  | { type: 'UPDATE_BACKGROUND'; patch: Partial<BackgroundImage> }
  | { type: 'LOAD_DOCUMENT'; document: Document }
  | { type: 'CLEAR' };

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function colorKey(o: EmbObject): string {
  return `${o.color.r},${o.color.g},${o.color.b}`;
}

/** Hatch's "Apply Closest Join": re-sequences objects so consecutive stitching
 * travels as little as possible and each thread color is stitched in one
 * contiguous block (never re-threaded twice) — matching the trim/continuous-jump
 * logic buildPattern already applies based on that final order. Which color goes
 * first/second/etc is left alone (first appearance order); only the objects
 * *within* each color get reordered, and reversed/rotated when that gets their
 * starting point closer to wherever the thread just finished. */
function optimizeStitchOrder(objects: EmbObject[]): EmbObject[] {
  const colorOrder: string[] = [];
  const groups = new Map<string, EmbObject[]>();
  for (const o of objects) {
    const key = colorKey(o);
    if (!groups.has(key)) {
      groups.set(key, []);
      colorOrder.push(key);
    }
    groups.get(key)!.push(o);
  }

  // Start from the overall design's center, a reasonable stand-in for where the
  // machine actually begins (buildPattern centers the exported file the same way).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    for (const p of o.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  let cursor = minX === Infinity ? { x: 0, y: 0 } : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  const result: EmbObject[] = [];
  for (const key of colorOrder) {
    const remaining = groups.get(key)!.slice();
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      let bestRotate = 0;
      let bestReversed = false;
      for (let i = 0; i < remaining.length; i++) {
        const o = remaining[i];
        if (o.kind === 'fill') {
          for (let v = 0; v < o.points.length; v++) {
            const d = dist(cursor, o.points[v]);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
              bestRotate = v;
              bestReversed = false;
            }
          }
        } else {
          const dStart = dist(cursor, o.points[0]);
          const dEnd = dist(cursor, o.points[o.points.length - 1]);
          if (dStart < bestDist) {
            bestDist = dStart;
            bestIdx = i;
            bestReversed = false;
          }
          if (dEnd < bestDist) {
            bestDist = dEnd;
            bestIdx = i;
            bestReversed = true;
          }
        }
      }
      const chosen = remaining.splice(bestIdx, 1)[0];
      let points = chosen.points;
      if (chosen.kind === 'fill' && bestRotate > 0) {
        points = [...points.slice(bestRotate), ...points.slice(0, bestRotate)];
      } else if (bestReversed) {
        points = [...points].reverse();
      }
      const finalObj = points === chosen.points ? chosen : { ...chosen, points };
      result.push(finalObj);
      cursor = finalObj.points[finalObj.points.length - 1];
    }
  }
  return result;
}

function bboxOf(o: EmbObject): { minX: number; minY: number; maxX: number; maxY: number } {
  const flat = flattenPath(o.points, o.kind === 'fill');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of flat) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function reducer(state: Document, action: Action): Document {
  switch (action.type) {
    case 'ADD_OBJECT':
      return { ...state, objects: [...state.objects, action.object] };
    case 'UPDATE_OBJECT':
      return {
        ...state,
        objects: state.objects.map((o) => (o.id === action.id ? { ...o, ...action.patch } : o)),
      };
    case 'REMOVE_OBJECT':
      return { ...state, objects: state.objects.filter((o) => o.id !== action.id) };
    case 'DUPLICATE_OBJECT': {
      const index = state.objects.findIndex((o) => o.id === action.id);
      if (index === -1) return state;
      const original = state.objects[index];
      const offset = 5; // mm, so the copy doesn't sit invisibly on top of the original
      const copy: EmbObject = {
        ...original,
        id: action.newId,
        name: `${original.name} copy`,
        points: original.points.map((p) => ({ ...p, x: p.x + offset, y: p.y + offset })),
      };
      const objects = state.objects.slice();
      objects.splice(index + 1, 0, copy);
      return { ...state, objects };
    }
    case 'REORDER': {
      const objs = state.objects.slice();
      const [moved] = objs.splice(action.fromIndex, 1);
      objs.splice(action.toIndex, 0, moved);
      return { ...state, objects: objs };
    }
    case 'ALIGN_OBJECTS': {
      if (action.ids.length < 2) return state;
      const targets = state.objects.filter((o) => action.ids.includes(o.id));
      const boxes = new Map(targets.map((o) => [o.id, bboxOf(o)]));
      // Align to the union bounding box of the whole selection (not a "key object") —
      // the conventional default when no single object is designated as the anchor.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const b of boxes.values()) {
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
      }
      return {
        ...state,
        objects: state.objects.map((o) => {
          const b = boxes.get(o.id);
          if (!b) return o;
          let dx = 0;
          let dy = 0;
          switch (action.mode) {
            case 'left': dx = minX - b.minX; break;
            case 'right': dx = maxX - b.maxX; break;
            case 'centerH': dx = (minX + maxX) / 2 - (b.minX + b.maxX) / 2; break;
            case 'top': dy = minY - b.minY; break;
            case 'bottom': dy = maxY - b.maxY; break;
            case 'centerV': dy = (minY + maxY) / 2 - (b.minY + b.maxY) / 2; break;
          }
          if (dx === 0 && dy === 0) return o;
          return { ...o, points: o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
        }),
      };
    }
    case 'OPTIMIZE_STITCH_ORDER':
      return { ...state, objects: optimizeStitchOrder(state.objects) };
    case 'SET_HOOP':
      return { ...state, hoop: action.hoop };
    case 'SET_NAME':
      return { ...state, name: action.name };
    case 'SET_TRIM_THRESHOLD':
      return { ...state, trimThresholdMm: Math.max(1, Math.min(10, action.mm)) };
    case 'SET_BACKGROUND':
      return { ...state, background: action.background };
    case 'UPDATE_BACKGROUND':
      return { ...state, background: state.background ? { ...state.background, ...action.patch } : state.background };
    case 'LOAD_DOCUMENT':
      return { ...action.document, background: action.document.background ?? null, trimThresholdMm: action.document.trimThresholdMm ?? 3 };
    case 'CLEAR':
      return { ...initialDocument, objects: [] };
    default:
      return state;
  }
}

// Actions that fire repeatedly for the same edit (dragging an object, typing in a
// number field) coalesce into a single undo step instead of one per event — grouped
// by this key, as long as they land within COALESCE_WINDOW_MS of each other. Anything
// else (add/remove/reorder/hoop/name/background swap/load) is always its own step.
function coalesceKey(action: Action): string | null {
  if (action.type === 'UPDATE_OBJECT') return `update-object-${action.id}`;
  if (action.type === 'UPDATE_BACKGROUND') return 'update-background';
  return null;
}

const COALESCE_WINDOW_MS = 600;
const MAX_HISTORY = 100;

interface History {
  past: Document[];
  future: Document[];
}

// Deliberately not built on useReducer/setState-with-a-function here: React 18
// StrictMode double-invokes a functional state updater in dev (to catch impure
// ones), and an updater that mutates historyRef as a side effect — as an earlier
// version of this did — gets that mutation applied twice per dispatch, corrupting
// the history stack. docRef mirrors `doc` synchronously so dispatch/undo/redo can
// read the latest value directly and hand setDocState a plain value instead.
function useHistoryStore(initial: Document) {
  const [doc, setDocState] = useState<Document>(initial);
  const docRef = useRef<Document>(initial);
  const historyRef = useRef<History>({ past: [], future: [] });
  const lastKeyRef = useRef<string | null>(null);
  const lastTimeRef = useRef<number>(0);

  const dispatch = useCallback((action: Action) => {
    const present = docRef.current;
    if (action.type === 'LOAD_DOCUMENT' || action.type === 'CLEAR') {
      historyRef.current = { past: [], future: [] };
      lastKeyRef.current = null;
    } else {
      const key = coalesceKey(action);
      const now = Date.now();
      const coalescing = key !== null && key === lastKeyRef.current && now - lastTimeRef.current < COALESCE_WINDOW_MS;
      lastKeyRef.current = key;
      lastTimeRef.current = now;
      if (!coalescing) {
        historyRef.current = { past: [...historyRef.current.past, present].slice(-MAX_HISTORY), future: [] };
      } else {
        historyRef.current = { ...historyRef.current, future: [] };
      }
    }
    const next = reducer(present, action);
    docRef.current = next;
    setDocState(next);
  }, []);

  const undo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    historyRef.current = { past: past.slice(0, -1), future: [docRef.current, ...future] };
    lastKeyRef.current = null;
    docRef.current = previous;
    setDocState(previous);
  }, []);

  const redo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (future.length === 0) return;
    const next = future[0];
    historyRef.current = { past: [...past, docRef.current], future: future.slice(1) };
    lastKeyRef.current = null;
    docRef.current = next;
    setDocState(next);
  }, []);

  return {
    doc,
    dispatch,
    undo,
    redo,
    canUndo: historyRef.current.past.length > 0,
    canRedo: historyRef.current.future.length > 0,
  };
}

interface StoreValue {
  doc: Document;
  dispatch: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  // The full multi-select set (marquee-drag select on the canvas). selectedId always
  // tracks the "primary" one (first in the set) for Properties panel editing, which
  // only ever shows one object's settings at a time. Setting one keeps the other in sync.
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  tool: ToolId;
  setTool: (t: ToolId) => void;
  activeColor: RGB;
  setActiveColor: (c: RGB) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

const STORAGE_KEY = 'embroidery-digitizer-doc';

function loadInitial(): Document {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Document;
      return {
        ...parsed,
        background: parsed.background ?? null,
        trimThresholdMm: parsed.trimThresholdMm ?? 3,
        // Docs saved before pullCompensation existed have satin/fill objects missing it.
        objects: parsed.objects.map((o) => {
          if (o.kind === 'satin' && o.satin.pullCompensation === undefined) {
            return { ...o, satin: { ...o.satin, pullCompensation: 0.2 } };
          }
          if (
            o.kind === 'fill' &&
            (o.fill.pullCompensation === undefined ||
              o.fill.startPoint === undefined ||
              o.fill.endPoint === undefined ||
              o.fill.bridgeMode === undefined)
          ) {
            return {
              ...o,
              fill: {
                ...o.fill,
                pullCompensation: o.fill.pullCompensation ?? 0.3,
                startPoint: o.fill.startPoint ?? null,
                endPoint: o.fill.endPoint ?? null,
                bridgeMode: o.fill.bridgeMode ?? 'perimeter',
              },
            };
          }
          return o;
        }),
      };
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return initialDocument;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { doc, dispatch, undo, redo, canUndo, canRedo } = useHistoryStore(loadInitial());
  const [selectedId, setSelectedIdRaw] = useState<string | null>(null);
  const [selectedIds, setSelectedIdsRaw] = useState<string[]>([]);
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdRaw(id);
    setSelectedIdsRaw(id ? [id] : []);
  }, []);
  const setSelectedIds = useCallback((ids: string[]) => {
    setSelectedIdsRaw(ids);
    setSelectedIdRaw(ids[0] ?? null);
  }, []);
  const [tool, setTool] = useState<ToolId>('select');
  const [activeColor, setActiveColor] = useState<RGB>({ r: 237, g: 23, b: 31 });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      // storage full or unavailable; autosave is best-effort
    }
  }, [doc]);

  return (
    <StoreContext.Provider
      value={{
        doc,
        dispatch,
        undo,
        redo,
        canUndo,
        canRedo,
        selectedId,
        setSelectedId,
        selectedIds,
        setSelectedIds,
        tool,
        setTool,
        activeColor,
        setActiveColor,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
