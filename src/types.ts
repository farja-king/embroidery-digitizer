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
// see stitching/underlay.ts for what each one actually generates.
export type UnderlayType = 'none' | 'center-run' | 'edge-run' | 'zigzag' | 'double-zigzag' | 'tatami';

export interface UnderlaySettings {
  // 'auto' picks a type + spacing from the object's own width/area (see stitching/underlay.ts
  // autoUnderlayType); 'manual' uses `type`/`spacing` below as set by the user.
  mode: 'auto' | 'manual';
  type: UnderlayType;
  spacing: number; // mm; row spacing (tatami/zigzag) or stitch length (run types)
}

export function defaultUnderlay(type: UnderlayType = 'none'): UnderlaySettings {
  return { mode: 'auto', type, spacing: 2.5 };
}

export interface SatinParams {
  width: number; // mm, rail-to-rail
  density: number; // mm between zigzag stitches along the path
  underlay: UnderlaySettings;
}

export interface FillParams {
  angle: number; // degrees, scan-line direction
  rowSpacing: number; // mm between rows
  stitchLength: number; // mm along each row
  underlay: UnderlaySettings;
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
}
