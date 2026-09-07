import { ByteWriter } from './byteWriter';
import type { MachinePattern } from './model';
import { nearestJefIndex } from './jefPalette';

const HOOP_110X110 = 0;
const HOOP_50X50 = 1;
const HOOP_140X200 = 2;
const HOOP_126X110 = 3;
const HOOP_200X200 = 4;

function getJefHoopSize(width: number, height: number): number {
  if (width < 500 && height < 500) return HOOP_50X50;
  if (width < 1260 && height < 1100) return HOOP_126X110;
  if (width < 1400 && height < 2000) return HOOP_140X200;
  if (width < 2000 && height < 2000) return HOOP_200X200;
  return HOOP_110X110;
}

function writeHoopEdgeDistance(w: ByteWriter, x: number, y: number): void {
  if (Math.min(x, y) >= 0) {
    w.u32le(x);
    w.u32le(y);
    w.u32le(x);
    w.u32le(y);
  } else {
    w.u32le(-1);
    w.u32le(-1);
    w.u32le(-1);
    w.u32le(-1);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function encodeJEF(pattern: MachinePattern): Uint8Array {
  const w = new ByteWriter();
  const now = new Date();
  const dateString =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  // Build the color palette in stitch order, matching each thread to the nearest JEF color,
  // nudging away from the previous slot's color so back-to-back colors never collide.
  const palette: number[] = [];
  let lastIndex: number | null = null;
  for (const t of pattern.threads) {
    let idx = nearestJefIndex(t, null);
    if (idx === lastIndex) {
      idx = nearestJefIndex(t, lastIndex);
    }
    palette.push(idx);
    lastIndex = idx;
  }
  const colorCount = palette.length || 1;
  if (palette.length === 0) palette.push(1);

  const TRIM_HOPS = 3;
  let pointCount = 1; // the final END marker
  for (const s of pattern.stitches) {
    if (s.command === 'STITCH') pointCount += 1;
    else if (s.command === 'JUMP') pointCount += 2;
    else if (s.command === 'TRIM') pointCount += 2 * TRIM_HOPS;
    else if (s.command === 'COLOR_CHANGE') pointCount += 2;
  }

  const offsets = 0x74 + colorCount * 8;
  w.u32le(offsets);
  w.u32le(0x14);
  w.ascii(dateString);
  w.u8(0);
  w.u8(0);
  w.u32le(colorCount);
  w.u32le(pointCount);

  const b = pattern.bounds;
  const designWidth = Math.round(b.maxX - b.minX);
  const designHeight = Math.round(b.maxY - b.minY);
  w.u32le(getJefHoopSize(designWidth, designHeight));

  const halfWidth = Math.round(designWidth / 2);
  const halfHeight = Math.round(designHeight / 2);
  w.u32le(halfWidth);
  w.u32le(halfHeight);
  w.u32le(halfWidth);
  w.u32le(halfHeight);

  writeHoopEdgeDistance(w, 550 - halfWidth, 550 - halfHeight);
  writeHoopEdgeDistance(w, 250 - halfWidth, 250 - halfHeight);
  writeHoopEdgeDistance(w, 700 - halfWidth, 1000 - halfHeight);
  writeHoopEdgeDistance(w, 700 - halfWidth, 1000 - halfHeight);

  for (const idx of palette) w.u32le(idx);
  for (let i = 0; i < colorCount; i++) w.u32le(0x0d);

  let xx = 0;
  let yy = 0;
  for (const s of pattern.stitches) {
    const dx = Math.round(s.x - xx);
    const dy = Math.round(s.y - yy);
    if (Math.abs(dx) > 127 || Math.abs(dy) > 127) {
      throw new Error(`JEF stitch delta out of range: dx=${dx} dy=${dy}`);
    }

    if (s.command === 'STITCH') {
      xx += dx;
      yy += dy;
      w.u8(dx);
      w.u8(-dy);
    } else if (s.command === 'COLOR_CHANGE') {
      xx += dx;
      yy += dy;
      w.bytes([0x80, 0x01]);
      w.u8(dx);
      w.u8(-dy);
    } else if (s.command === 'JUMP') {
      xx += dx;
      yy += dy;
      w.bytes([0x80, 0x02]);
      w.u8(dx);
      w.u8(-dy);
    } else if (s.command === 'TRIM') {
      // Zero-delta by convention (JUMP already relocated the needle) — repeated
      // 0x80 0x02 0x00 0x00 is Janome's "trim thread here" idiom.
      for (let i = 0; i < TRIM_HOPS; i++) w.bytes([0x80, 0x02, 0x00, 0x00]);
    }
  }
  w.bytes([0x80, 0x10]);

  return w.toUint8Array();
}
