import { useStore } from '../state/store';
import type { EmbObject, UnderlaySettings, UnderlayType } from '../types';
import { autoUnderlayType } from '../stitching/underlay';

const UNDERLAY_LABELS: Record<UnderlayType, string> = {
  none: 'None',
  'center-run': 'Center run',
  'edge-run': 'Edge run',
  zigzag: 'Zigzag',
  'double-zigzag': 'Double zigzag',
  tatami: 'Tatami',
};

function UnderlayField({
  obj,
  underlay,
  onChange,
}: {
  obj: EmbObject;
  underlay: UnderlaySettings;
  onChange: (u: UnderlaySettings) => void;
}) {
  const autoType = autoUnderlayType(obj);
  return (
    <div className="underlay-field">
      <div className="field-label">Underlay</div>
      <div className="underlay-mode-toggle">
        <button className={underlay.mode === 'auto' ? 'active' : ''} onClick={() => onChange({ ...underlay, mode: 'auto' })}>
          Auto
        </button>
        <button className={underlay.mode === 'manual' ? 'active' : ''} onClick={() => onChange({ ...underlay, mode: 'manual' })}>
          Manual
        </button>
      </div>
      {underlay.mode === 'auto' ? (
        <p className="muted underlay-auto-note">Using {UNDERLAY_LABELS[autoType]} based on this shape's size.</p>
      ) : (
        <>
          <label className="field">
            Type
            <select value={underlay.type} onChange={(e) => onChange({ ...underlay, type: e.target.value as UnderlayType })}>
              {(Object.keys(UNDERLAY_LABELS) as UnderlayType[]).map((t) => (
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

function rgbToHex(c: { r: number; g: number; b: number }): string {
  return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export default function PropertiesPanel() {
  const { doc, dispatch, selectedId } = useStore();
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
          <UnderlayField obj={obj} underlay={obj.satin.underlay} onChange={(underlay) => update({ satin: { ...obj.satin, underlay } })} />
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
          <UnderlayField obj={obj} underlay={obj.fill.underlay} onChange={(underlay) => update({ fill: { ...obj.fill, underlay } })} />
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
