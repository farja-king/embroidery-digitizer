// All coordinates in this app are millimetres, screen/canvas convention (+x right, +y down).

export interface Point {
  x: number;
  y: number;
}

export type PointType = 'corner' | 'curve';

// A path/polygon vertex: 'corner' draws a straight line into and out of it (square
// handle in the editor); 'curve' makes the path smooth through it (circle handle),
// via a Catmull-Rom-derived curve using its neighbors.
export interface PathPoint extends Point {
  type: PointType;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type StitchKind = 'running' | 'satin' | 'fill';
export type ToolId = 'select' | 'running' | 'satin' | 'fill' | 'rect' | 'ellipse';

export interface RunningParams {
  stitchLength: number; // mm
  triple: boolean; // stitch each segment 3x (hand-look / bartack style reinforcement)
}

// 'none' disables underlay entirely. The rest name a real digitizing underlay pattern —
// see stitching/underlay.ts for what each one actually generates. Per Hatch's own
// underlay model, zigzag/double-zigzag are a *column* (satin) concept — an angled
// bounce stitch across the width — and tatami/double-tatami are a *fill* concept —
// straight rows across the area, "double" meaning a second crossed pass (horizontal
// then vertical). They're deliberately kept as distinct type values (not the same
// "double" reused for both) so the UI only ever offers the pair that matches the
// selected object's kind — see UNDERLAY_TYPES_BY_KIND in PropertiesPanel.tsx.
export type UnderlayType = 'none' | 'center-run' | 'edge-run' | 'zigzag' | 'double-zigzag' | 'tatami' | 'double-tatami';

export interface UnderlaySettings {
  // 'auto' picks a type + spacing from the object's own width/area (see stitching/underlay.ts
  // autoUnderlayType) for pass 1, or 'none' for pass 2 — there's no sensible auto rule for
  // a second pass, it's opt-in. 'manual' uses `type`/`spacing` below as set by the user.
  mode: 'auto' | 'manual';
  type: UnderlayType;
  spacing: number; // mm; row spacing (tatami/zigzag) or stitch length (run types)
}

export function defaultUnderlay(type: UnderlayType = 'none', mode: 'auto' | 'manual' = 'auto'): UnderlaySettings {
  return { mode, type, spacing: 2.5 };
}

// Two sequential underlay passes — e.g. an edge-run pass 1 followed by a tatami or
// zigzag pass 2, a common combination for stabilizing before dense top stitching.
export interface TwoPassUnderlay {
  pass1: UnderlaySettings;
  pass2: UnderlaySettings;
}

export function defaultTwoPassUnderlay(pass1Type: UnderlayType): TwoPassUnderlay {
  return { pass1: defaultUnderlay(pass1Type, 'auto'), pass2: defaultUnderlay('none', 'manual') };
}

export interface SatinParams {
  width: number; // mm, rail-to-rail
  density: number; // mm between zigzag stitches along the path
  underlay: TwoPassUnderlay;
  // mm added to each rail's half-width. Stitched fabric "pulls in" toward the
  // column's centerline as thread tension draws the rows together, so a column
  // sewn at its exact digitized width comes out visibly narrower on fabric.
  // Pull compensation pushes each rail outward by this much to counteract it —
  // a standard Hatch/industry technique, not a cosmetic setting.
  pullCompensation: number;
}

export interface FillParams {
  angle: number; // degrees, scan-line direction
  rowSpacing: number; // mm between rows
  stitchLength: number; // mm along each row
  underlay: TwoPassUnderlay;
  // mm the top stitching's outer edge is pushed outward beyond the digitized
  // outline, same idea as satin's pullCompensation — dense fill stitching pulls
  // fabric in toward the shape's center, so an uncompensated fill comes out
  // slightly smaller than drawn. The underlay is deliberately left on the
  // original (unexpanded) boundary, so it stays safely inset under the top
  // stitching instead of its own edge stitches poking past where the top layer
  // covers them — the two together read as a clean edge instead of the ragged
  // look of both layers' stitches landing at slightly different boundaries.
  pullCompensation: number;
  // Explicit first/final needle position, independent of wherever the row-scan
  // pattern would naturally start/finish -- set by dragging the start (green) /
  // end (red) marker on canvas. null/undefined means "wherever the scan naturally
  // starts/ends" (the original, pre-this-feature behavior). When set, the engine
  // adds a short bridge stitch walking the shape's own edge between this point and
  // the scan's natural start/finish, so two same-color shapes can be lined up
  // end-to-start for continuous, no-trim stitching instead of always landing
  // wherever the scan happens to begin/stop.
  startPoint: Point | null;
  endPoint: Point | null;
  // How the bridge stitches above (start/end alignment, and the underlay-to-top
  // handoff) get from one point to another: 'perimeter' walks the shape's own
  // edge (the default -- keeps travel stitches hidden under where the fill
  // itself will cover them), 'straight' cuts directly through the interior
  // (shorter, but only hidden if the fill is dense enough to bury it).
  bridgeMode: 'perimeter' | 'straight';
  // A hand-drawn curve (open path, design-space mm) that overrides `angle` as
  // the row direction -- rows become offset copies of this curve, clipped to
  // the shape, so stitch direction follows the guide's own bend instead of a
  // single fixed angle (the standard "guided fill" technique for a shape
  // whose grain should curve, e.g. an "S"). null means "use `angle`" (the
  // original, pre-this-feature behavior).
  guideLine: PathPoint[] | null;
}

export interface EmbObject {
  id: string;
  kind: StitchKind;
  name: string;
  points: PathPoint[]; // design-space mm; open path for running/satin centerline, closed polygon for fill
  color: RGB;
  visible: boolean;
  locked: boolean;
  running: RunningParams;
  satin: SatinParams;
  fill: FillParams;
}

export interface HoopSize {
  name: string;
  width: number; // mm
  height: number; // mm
}

export const HOOP_PRESETS: HoopSize[] = [
  { name: '4x4"', width: 100, height: 100 },
  { name: '5x7"', width: 130, height: 180 },
  { name: '6x10"', width: 160, height: 260 },
  { name: '8x8"', width: 200, height: 200 },
  { name: '9x9"', width: 240, height: 240 },
];

export interface BackgroundImage {
  src: string; // data URL
  x: number; // mm, design-space center
  y: number; // mm, design-space center
  width: number; // mm
  height: number; // mm
  opacity: number; // 0..1
  visible: boolean; // toggled with the D key
}

export interface Document {
  name: string;
  hoop: HoopSize;
  objects: EmbObject[];
  background: BackgroundImage | null;
  // mm; a jump between stitches at or beyond this length gets an inserted TRIM
  // command (thread cut) instead of just traveling as a plain jump stitch. 1-10mm,
  // user-configurable (Hatch's own default is 3mm, which is this app's default too).
  trimThresholdMm: number;
}
