import { ByteWriter } from './byteWriter';
import type { MachinePattern } from './model';

const HEADER_SIZE = 512;

function bit(b: number): number {
  return 1 << b;
}

/** Tajima DST 3-byte stitch record. dx/dy must each be in [-121, 121] (0.1mm units). */
function encodeRecord(w: ByteWriter, dx: number, dyIn: number, flag: 'STITCH' | 'JUMP' | 'COLOR_CHANGE' | 'END'): void {
  const dy = -dyIn; // DST's y axis is flipped relative to our screen-down convention
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;

  if (flag === 'COLOR_CHANGE') {
    w.bytes([0, 0, 0b11000011]);
    return;
  }
  if (flag === 'END') {
    w.bytes([0, 0, 0b11110011]);
    return;
  }

  if (flag === 'JUMP') b2 += bit(7);
  b2 += bit(0);
  b2 += bit(1);

  let x = dx;
  let y = dy;
  if (Math.abs(x) > 121 || Math.abs(y) > 121) {
    throw new Error(`DST stitch delta out of range: dx=${dx} dy=${dyIn}`);
  }

  if (x > 40) { b2 += bit(2); x -= 81; }
  if (x < -40) { b2 += bit(3); x += 81; }
  if (x > 13) { b1 += bit(2); x -= 27; }
  if (x < -13) { b1 += bit(3); x += 27; }
  if (x > 4) { b0 += bit(2); x -= 9; }
  if (x < -4) { b0 += bit(3); x += 9; }
  if (x > 1) { b1 += bit(0); x -= 3; }
  if (x < -1) { b1 += bit(1); x += 3; }
  if (x > 0) { b0 += bit(0); x -= 1; }
  if (x < 0) { b0 += bit(1); x += 1; }
  if (x !== 0) throw new Error(`DST encoder residual x=${x}`);

  if (y > 40) { b2 += bit(5); y -= 81; }
  if (y < -40) { b2 += bit(4); y += 81; }
  if (y > 13) { b1 += bit(5); y -= 27; }
  if (y < -13) { b1 += bit(4); y += 27; }
  if (y > 4) { b0 += bit(5); y -= 9; }
  if (y < -4) { b0 += bit(4); y += 9; }
  if (y > 1) { b1 += bit(7); y -= 3; }
  if (y < -1) { b1 += bit(6); y += 3; }
  if (y > 0) { b0 += bit(7); y -= 1; }
  if (y < 0) { b0 += bit(6); y += 1; }
  if (y !== 0) throw new Error(`DST encoder residual y=${y}`);

  w.bytes([b0, b1, b2]);
}

export function encodeDST(pattern: MachinePattern): Uint8Array {
  const w = new ByteWriter();
  const stitches = pattern.stitches;
  const stitchCount = stitches.filter((s) => s.command === 'STITCH' || s.command === 'JUMP').length;
  const colorChanges = stitches.filter((s) => s.command === 'COLOR_CHANGE').length;
  const b = pattern.bounds;

  const last = stitches[stitches.length - 1];
  const ax = last ? Math.round(last.x) : 0;
  const ay = last ? -Math.round(last.y) : 0;

  w.ascii(`LA:${pattern.name.slice(0, 16).padEnd(16)}\r`);
  w.ascii(`ST:${String(stitchCount).padStart(7)}\r`);
  w.ascii(`CO:${String(colorChanges).padStart(3)}\r`);
  w.ascii(`+X:${String(Math.abs(Math.round(b.maxX))).padStart(5)}\r`);
  w.ascii(`-X:${String(Math.abs(Math.round(b.minX))).padStart(5)}\r`);
  w.ascii(`+Y:${String(Math.abs(Math.round(b.maxY))).padStart(5)}\r`);
  w.ascii(`-Y:${String(Math.abs(Math.round(b.minY))).padStart(5)}\r`);
  w.ascii(`AX:${ax >= 0 ? '+' : '-'}${String(Math.abs(ax)).padStart(5)}\r`);
  w.ascii(`AY:${ay >= 0 ? '+' : '-'}${String(Math.abs(ay)).padStart(5)}\r`);
  w.ascii(`MX:+${String(0).padStart(5)}\r`);
  w.ascii(`MY:+${String(0).padStart(5)}\r`);
  w.ascii(`PD:${'******'.padStart(6)}\r`);
  w.u8(0x1a);
  while (w.length < HEADER_SIZE) w.u8(0x20);

  let xx = 0;
  let yy = 0;
  for (const s of stitches) {
    if (s.command === 'END') {
      encodeRecord(w, 0, 0, 'END');
      continue;
    }
    if (s.command === 'TRIM') {
      // DST has no native trim record; emulate Tajima's convention of a small
      // jump zig-zag, which every DST-reading machine interprets as a thread trim.
      let delta = -4;
      encodeRecord(w, -delta / 2, -delta / 2, 'JUMP');
      for (let p = 1; p < 3 - 1; p++) {
        encodeRecord(w, delta, delta, 'JUMP');
        delta = -delta;
      }
      encodeRecord(w, delta / 2, delta / 2, 'JUMP');
      continue;
    }
    const dx = Math.round(s.x - xx);
    const dy = Math.round(s.y - yy);
    xx += dx;
    yy += dy;
    encodeRecord(w, dx, dy, s.command === 'COLOR_CHANGE' ? 'COLOR_CHANGE' : s.command === 'JUMP' ? 'JUMP' : 'STITCH');
  }

  return w.toUint8Array();
}
