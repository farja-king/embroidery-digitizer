import type { StitchPoint } from '../stitching/engine';
import type { RGB } from '../types';

export type MCommand = 'STITCH' | 'JUMP' | 'TRIM' | 'COLOR_CHANGE' | 'END';

/** A stitch in machine units: 1 unit = 0.1mm, matching DST/EXP/JEF/PES convention. */
export interface MStitch {
  x: number; // absolute, 0.1mm units
  y: number; // absolute, 0.1mm units
  command: MCommand;
}

export interface MachinePattern {
  stitches: MStitch[];
  threads: RGB[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  name: string;
}

/** Converts design-space mm stitches (+y down) into the integer 0.1mm pattern every
 * writer below expects, centered so (0,0) sits at the design's bounding-box center —
 * the convention embroidery machines use to position a design in the hoop. */
export function toMachinePattern(stitches: StitchPoint[], threads: RGB[], name: string): MachinePattern {
  if (stitches.length === 0) {
    return { stitches: [], threads, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, name };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Only real stitches define the design's extent — jump waypoints (including the
  // initial travel from the machine's (0,0) start) shouldn't skew where it's centered.
  const contentStitches = stitches.filter((s) => s.command === 'STITCH');
  for (const s of contentStitches.length ? contentStitches : stitches) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const out: MStitch[] = stitches.map((s) => ({
    x: Math.round((s.x - cx) * 10),
    y: Math.round((s.y - cy) * 10),
    command: s.command,
  }));

  return {
    stitches: out,
    threads,
    bounds: {
      minX: Math.round((minX - cx) * 10),
      minY: Math.round((minY - cy) * 10),
      maxX: Math.round((maxX - cx) * 10),
      maxY: Math.round((maxY - cy) * 10),
    },
    name,
  };
}
