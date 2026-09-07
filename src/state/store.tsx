import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackgroundImage, Document, EmbObject, HoopSize, PathPoint, RGB, StitchKind, ToolId } from '../types';
import { HOOP_PRESETS, defaultTwoPassUnderlay } from '../types';

function makeId(): string {
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
    satin: { width: 3, density: 0.4, underlay: defaultTwoPassUnderlay('zigzag') },
    fill: { angle: 0, rowSpacing: 0.4, stitchLength: 3, underlay: defaultTwoPassUnderlay('tatami') },
  };
}

const initialDocument: Document = {
  name: 'Untitled Design',
  hoop: HOOP_PRESETS[0],
  objects: [],
  background: null,
};

type Action =
  | { type: 'ADD_OBJECT'; object: EmbObject }
  | { type: 'UPDATE_OBJECT'; id: string; patch: Partial<EmbObject> }
  | { type: 'REMOVE_OBJECT'; id: string }
  | { type: 'REORDER'; fromIndex: number; toIndex: number }
  | { type: 'SET_HOOP'; hoop: HoopSize }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_BACKGROUND'; background: BackgroundImage | null }
  | { type: 'UPDATE_BACKGROUND'; patch: Partial<BackgroundImage> }
  | { type: 'LOAD_DOCUMENT'; document: Document }
  | { type: 'CLEAR' };

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
    case 'REORDER': {
      const objs = state.objects.slice();
      const [moved] = objs.splice(action.fromIndex, 1);
      objs.splice(action.toIndex, 0, moved);
      return { ...state, objects: objs };
    }
    case 'SET_HOOP':
      return { ...state, hoop: action.hoop };
    case 'SET_NAME':
      return { ...state, name: action.name };
    case 'SET_BACKGROUND':
      return { ...state, background: action.background };
    case 'UPDATE_BACKGROUND':
      return { ...state, background: state.background ? { ...state.background, ...action.patch } : state.background };
    case 'LOAD_DOCUMENT':
      return { ...action.document, background: action.document.background ?? null };
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
      return { ...parsed, background: parsed.background ?? null };
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return initialDocument;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { doc, dispatch, undo, redo, canUndo, canRedo } = useHistoryStore(loadInitial());
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      value={{ doc, dispatch, undo, redo, canUndo, canRedo, selectedId, setSelectedId, tool, setTool, activeColor, setActiveColor }}
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
