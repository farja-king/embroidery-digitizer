import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';
import type { BackgroundImage, Document, EmbObject, HoopSize, PathPoint, RGB, StitchKind, ToolId } from '../types';
import { HOOP_PRESETS, defaultUnderlay } from '../types';

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
    satin: { width: 3, density: 0.4, underlay: defaultUnderlay('zigzag') },
    fill: { angle: 0, rowSpacing: 0.4, stitchLength: 3, underlay: defaultUnderlay('tatami') },
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

interface StoreValue {
  doc: Document;
  dispatch: React.Dispatch<Action>;
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
  const [doc, dispatch] = useReducer(reducer, undefined, loadInitial);
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
    <StoreContext.Provider value={{ doc, dispatch, selectedId, setSelectedId, tool, setTool, activeColor, setActiveColor }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
