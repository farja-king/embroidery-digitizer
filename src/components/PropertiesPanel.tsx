import { useStore, type AlignMode } from '../state/store';
import type { EmbObject, StitchKind, TwoPassUnderlay, UnderlaySettings, UnderlayType } from '../types';
import { autoUnderlayType, normalizeUnderlay } from '../stitching/underlay';
import { pointsForKindChange } from '../stitching/kindConvert';

const KIND_LABELS: Record<StitchKind, string> = { running: 'Running', satin: 'Satin', fill: 'Fill' };

const UNDERLAY_LABELS: Record<UnderlayType, string> = {
  none: 'None',
  'center-run': 'Center run',
  'edge-run': 'Edge run',
  zigzag: 'Zigzag',
  'double-zigzag': 'Double zigzag',
  tatami: 'Tatami',
  'double-tatami': 'Double tatami',
};

// Zigzag/double-zigzag (an angled bounce stitch across a width) is a satin-column
// concept; tatami/double-tatami (straight rows across an area) is a fill concept.
// Offering both for both kinds is what made them look identical in the UI before —
// each kind only ever sees the pair that actually applies to it.
const UNDERLAY_TYPES_BY_KIND: Record<StitchKind, UnderlayType[]> = {
  running: ['none'],
  satin: ['none', 'center-run', 'edge-run', 'zigzag', 'double-zigzag'],
  fill: ['none', 'center-run', 'edge-run', 'tatami', 'double-tatami'],
};

function UnderlayField({
  label,
  underlay,
  autoType,
  typeOptions,
  onChange,
}: {
  label: string;
  underlay: UnderlaySettings;
  autoType: UnderlayType | null; // null: this pass has no auto heuristic, "Auto" just means off
  typeOptions: UnderlayType[];
  onChange: (u: UnderlaySettings) => void;
}) {
  return (
    <div className="underlay-field">
      <div className="field-label">{label}</div>
      <div className="underlay-mode-toggle">
        <button className={underlay.mode === 'auto' ? 'active' : ''} onClick={() => onChange({ ...underlay, mode: 'auto' })}>
          Auto
        </button>
        <button className={underlay.mode === 'manual' ? 'active' : ''} onClick={() => onChange({ ...underlay, mode: 'manual' })}>
          Manual
        </button>
      </div>
      {underlay.mode === 'auto' ? (
        <p className="muted underlay-auto-note">
          {autoType ? `Using ${UNDERLAY_LABELS[autoType]} based on this shape's size.` : "Off — switch to Manual to add a pass here."}
        </p>
      ) : (
        <>
          <label className="field">
            Type
            <select value={underlay.type} onChange={(e) => onChange({ ...underlay, type: e.target.value as UnderlayType })}>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {UNDERLAY_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          {underlay.type !== 'none' && (
            <NumberField
              label="Spacing (mm)"
              value={underlay.spacing}
              min={0.5}
              max={6}
              step={0.1}
              onChange={(v) => onChange({ ...underlay, spacing: v })}
            />
          )}
        </>
      )}
    </div>
  );
}

function TwoPassUnderlayFields({
  obj,
  underlay,
  onChange,
}: {
  obj: EmbObject;
  underlay: TwoPassUnderlay | UnderlaySettings;
  onChange: (u: TwoPassUnderlay) => void;
}) {
  const normalized = normalizeUnderlay(underlay);
  const typeOptions = UNDERLAY_TYPES_BY_KIND[obj.kind];
  return (
    <>
      <UnderlayField
        label="Underlay 1"
        underlay={normalized.pass1}
        autoType={autoUnderlayType(obj)}
        typeOptions={typeOptions}
        onChange={(pass1) => onChange({ ...normalized, pass1 })}
      />
      <UnderlayField
        label="Underlay 2 (optional)"
        underlay={normalized.pass2}
        autoType={null}
        typeOptions={typeOptions}
        onChange={(pass2) => onChange({ ...normalized, pass2 })}
      />
    </>
  );
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const ALIGN_BUTTONS: { mode: AlignMode; label: string; title: string }[] = [
  { mode: 'left', label: '◧', title: 'Align left' },
  { mode: 'centerH', label: '↔', title: 'Center horizontally' },
  { mode: 'right', label: '◨', title: 'Align right' },
  { mode: 'top', label: '⬒', title: 'Align top' },
  { mode: 'centerV', label: '↕', title: 'Center vertically' },
  { mode: 'bottom', label: '⬓', title: 'Align bottom' },
];

export default function PropertiesPanel() {
  const { doc, dispatch, selectedId, selectedIds } = useStore();

  if (selectedIds.length > 1) {
    return (
      <div className="panel">
        <h3>Align selection</h3>
        <p className="muted">{selectedIds.length} objects selected.</p>
        <div className="align-buttons">
          {ALIGN_BUTTONS.map((b) => (
            <button key={b.title} title={b.title} onClick={() => dispatch({ type: 'ALIGN_OBJECTS', ids: selectedIds, mode: b.mode })}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const obj = doc.objects.find((o) => o.id === selectedId);

  if (!obj) {
    return (
      <div className="panel">
        <h3>Properties</h3>
        <p className="muted">Select an object to edit its stitch settings.</p>
      </div>
    );
  }

  const update = (patch: Partial<EmbObject>) => dispatch({ type: 'UPDATE_OBJECT', id: obj.id, patch });

  return (
    <div className="panel">
      <h3>Properties</h3>
      <label className="field">
        Name
        <input value={obj.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label className="field">
        Thread color
        <input type="color" value={rgbToHex(obj.color)} onChange={(e) => update({ color: hexToRgb(e.target.value) })} />
      </label>

      <div className="field">
        <span className="field-label">Stitch type</span>
        <div className="kind-convert-buttons">
          {(['running', 'satin', 'fill'] as StitchKind[]).map((k) => (
            <button
              key={k}
              className={obj.kind === k ? 'active' : ''}
              disabled={obj.kind === k}
              onClick={() => update({ kind: k, points: pointsForKindChange(obj.kind, k, obj.points) })}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      {obj.kind === 'running' && (
        <>
          <NumberField
            label="Stitch length (mm)"
            value={obj.running.stitchLength}
            min={0.5}
            max={12}
            step={0.1}
            onChange={(v) => update({ running: { ...obj.running, stitchLength: v } })}
          />
          <label className="field row">
            <input
              type="checkbox"
              checked={obj.running.triple}
              onChange={(e) => update({ running: { ...obj.running, triple: e.target.checked } })}
            />
            Triple stitch (reinforced)
          </label>
        </>
      )}

      {obj.kind === 'satin' && (
        <>
          <NumberField
            label="Width (mm)"
            value={obj.satin.width}
            min={0.5}
            max={12}
            step={0.1}
            onChange={(v) => update({ satin: { ...obj.satin, width: v } })}
          />
          <NumberField
            label="Density (mm/stitch)"
            value={obj.satin.density}
            min={0.2}
            max={2}
            step={0.1}
            onChange={(v) => update({ satin: { ...obj.satin, density: v } })}
          />
          <NumberField
            label="Pull compensation (mm)"
            value={obj.satin.pullCompensation}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ satin: { ...obj.satin, pullCompensation: v } })}
          />
          <TwoPassUnderlayFields
            obj={obj}
            underlay={obj.satin.underlay}
            onChange={(underlay) => update({ satin: { ...obj.satin, underlay } })}
          />
        </>
      )}

      {obj.kind === 'fill' && (
        <>
          <NumberField
            label="Angle (°)"
            value={obj.fill.angle}
            min={-90}
            max={90}
            step={5}
            onChange={(v) => update({ fill: { ...obj.fill, angle: v } })}
          />
          <NumberField
            label="Row spacing (mm)"
            value={obj.fill.rowSpacing}
            min={0.2}
            max={2}
            step={0.05}
            onChange={(v) => update({ fill: { ...obj.fill, rowSpacing: v } })}
          />
          <NumberField
            label="Stitch length (mm)"
            value={obj.fill.stitchLength}
            min={1}
            max={8}
            step={0.1}
            onChange={(v) => update({ fill: { ...obj.fill, stitchLength: v } })}
          />
          <TwoPassUnderlayFields
            obj={obj}
            underlay={obj.fill.underlay}
            onChange={(underlay) => update({ fill: { ...obj.fill, underlay } })}
          />
        </>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </label>
  );
}
