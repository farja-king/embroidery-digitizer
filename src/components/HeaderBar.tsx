import { useRef, useState } from 'react';
import { useStore } from '../state/store';
import { HOOP_PRESETS, type Document } from '../types';
import { exportStitchFile, type ExportFormat } from '../formats/exportPattern';
import StitchPlayback from './StitchPlayback';

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'dst', label: '.DST — Tajima (universal)' },
  { id: 'pes', label: '.PES — Brother/Babylock' },
  { id: 'exp', label: '.EXP — Melco/Bernina' },
  { id: 'jef', label: '.JEF — Janome' },
  { id: 'pec', label: '.PEC — Brother (raw)' },
];

export default function HeaderBar() {
  const { doc, dispatch } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showEmbNote, setShowEmbNote] = useState(false);
  const [showPlayback, setShowPlayback] = useState(false);

  const doExport = (format: ExportFormat) => {
    setExportError(null);
    try {
      exportStitchFile(doc.objects, doc.name, format);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProject = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name.replace(/[^a-z0-9_-]+/gi, '_') || 'design'}.edp.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openProject = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as Document;
        if (!parsed.objects || !parsed.hoop) throw new Error('Not a valid project file');
        dispatch({ type: 'LOAD_DOCUMENT', document: parsed });
      } catch {
        setExportError('Could not read that project file.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="header-bar">
      <div className="brand">Embroidery Digitizer</div>
      <input
        className="doc-name"
        value={doc.name}
        onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
      />
      <select
        className="hoop-select"
        value={doc.hoop.name}
        onChange={(e) => {
          const hoop = HOOP_PRESETS.find((h) => h.name === e.target.value);
          if (hoop) dispatch({ type: 'SET_HOOP', hoop });
        }}
      >
        {HOOP_PRESETS.map((h) => (
          <option key={h.name} value={h.name}>
            {h.name} hoop
          </option>
        ))}
      </select>

      <div className="spacer" />

      <button className="preview-btn" onClick={() => setShowPlayback(true)}>
        ▶ Preview stitch-out
      </button>
      <button onClick={saveProject}>Save project</button>
      <button onClick={() => fileInputRef.current?.click()}>Open project</button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openProject(f);
          e.target.value = '';
        }}
      />

      <div className="export-group">
        {FORMATS.map((f) => (
          <button key={f.id} className="export-btn" onClick={() => doExport(f.id)} title={f.label}>
            {f.id.toUpperCase()}
          </button>
        ))}
        <button className="export-btn emb-btn" onClick={() => setShowEmbNote(true)} title=".EMB (Wilcom)">
          EMB
        </button>
      </div>

      {exportError && (
        <div className="toast error" onClick={() => setExportError(null)}>
          {exportError}
        </div>
      )}

      {showEmbNote && (
        <div className="modal-overlay" onClick={() => setShowEmbNote(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>.EMB isn't supported</h3>
            <p>
              Wilcom's <code>.emb</code> format is closed and proprietary — there's no published spec, and even
              the most complete open-source embroidery libraries can't write it. Faking the bytes would produce
              a file that looks right but is silently corrupt.
            </p>
            <p>
              Export <strong>.DST</strong> instead (works on virtually every commercial machine) — Wilcom's own
              software can open a DST and re-save it as <code>.emb</code> if you specifically need that format.
            </p>
            <button onClick={() => setShowEmbNote(false)}>Got it</button>
          </div>
        </div>
      )}

      {showPlayback && <StitchPlayback onClose={() => setShowPlayback(false)} />}
    </div>
  );
}
