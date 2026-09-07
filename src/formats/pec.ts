import { ByteWriter } from './byteWriter';
import type { MachinePattern } from './model';
import { nearestBrotherIndex } from './brotherPalette';

const JUMP_CODE = 0b00010000;
const TRIM_CODE = 0b00100000;
const ICON_STRIDE = 6; // 48px wide / 8
const ICON_HEIGHT = 38;
const BLANK_ICON = new Array(ICON_STRIDE * ICON_HEIGHT).fill(0);

function writeValue(w: ByteWriter, valueIn: number, long: boolean, flag: number): void {
  let value = valueIn;
  if (!long && value > -64 && value < 63) {
    w.u8(value & 0x7f);
    return;
  }
  value &= 0b0000111111111111;
  value |= 0b1000000000000000;
  value |= flag << 8;
  w.u8((value >> 8) & 0xff); // big-endian for this 2-byte "long" form
  w.u8(value & 0xff);
}

function writeTrimJump(w: ByteWriter, dx: number, dy: number): void {
  writeValue(w, dx, true, TRIM_CODE);
  writeValue(w, dy, true, TRIM_CODE);
}

function writeJump(w: ByteWriter, dx: number, dy: number): void {
  writeValue(w, dx, true, JUMP_CODE);
  writeValue(w, dy, true, JUMP_CODE);
}

function writeStitch(w: ByteWriter, dx: number, dy: number): void {
  writeValue(w, dx, false, 0);
  writeValue(w, dy, false, 0);
}

function pecEncode(w: ByteWriter, pattern: MachinePattern): void {
  let colorTwo = true;
  let jumping = true;
  let init = true;
  let xx = 0;
  let yy = 0;

  for (const s of pattern.stitches) {
    const dx = Math.round(s.x - xx);
    const dy = Math.round(s.y - yy);

    if (s.command === 'STITCH' || s.command === 'JUMP') {
      xx += dx;
      yy += dy;
    }

    if (s.command === 'STITCH') {
      if (jumping) {
        if (dx !== 0 && dy !== 0) writeStitch(w, 0, 0);
        jumping = false;
      }
      writeStitch(w, dx, dy);
    } else if (s.command === 'JUMP') {
      jumping = true;
      if (init) writeJump(w, dx, dy);
      else writeTrimJump(w, dx, dy);
    } else if (s.command === 'COLOR_CHANGE') {
      if (jumping) {
        writeStitch(w, 0, 0);
        jumping = false;
      }
      w.bytes([0xfe, 0xb0]);
      w.u8(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (s.command === 'TRIM') {
      // No-op: every JUMP after the first is already flagged TRIM_CODE above,
      // so a standalone zero-delta trim marker carries no extra information here.
    } else if (s.command === 'END') {
      w.u8(0xff);
      break;
    }
    init = false;
  }
}

function matchThreadPalette(threads: MachinePattern['threads']): number[] {
  const indices: number[] = [];
  let last: number | null = null;
  for (const t of threads) {
    let idx = nearestBrotherIndex(t, null);
    if (idx === last) idx = nearestBrotherIndex(t, last);
    indices.push(idx);
    last = idx;
  }
  return indices;
}

function writePecHeader(w: ByteWriter, pattern: MachinePattern): number[] {
  const name = pattern.name.slice(0, 8).padEnd(16);
  w.ascii(`LA:${name}\r`);
  w.bytes([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xff, 0x00]);
  w.u8(ICON_STRIDE);
  w.u8(ICON_HEIGHT);

  const colorIndexList = matchThreadPalette(pattern.threads);
  const count = colorIndexList.length;
  if (count !== 0) {
    w.bytes([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
    w.u8(count - 1);
    for (const idx of colorIndexList) w.u8(idx);
  } else {
    w.bytes([0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff]);
  }
  for (let i = count; i < 463; i++) w.u8(0x20);
  return colorIndexList;
}

function writePecBlock(w: ByteWriter, pattern: MachinePattern): void {
  const width = Math.round(pattern.bounds.maxX - pattern.bounds.minX);
  const height = Math.round(pattern.bounds.maxY - pattern.bounds.minY);

  const blockStart = w.length;
  w.bytes([0x00, 0x00]);
  w.u24le(0); // patched below with the block's byte length
  w.bytes([0x31, 0xff, 0xf0]);
  w.u16le(width);
  w.u16le(height);
  w.u16le(0x1e0);
  w.u16le(0x1b0);
  pecEncode(w, pattern);

  const blockLength = w.length - blockStart;
  w.patchU24le(blockStart + 2, blockLength);
}

function writePecGraphics(w: ByteWriter, threadCount: number): void {
  w.bytes(BLANK_ICON); // overall design icon
  for (let i = 0; i < threadCount; i++) w.bytes(BLANK_ICON); // one per color block
}

/** Writes the PEC payload (header + stitch block + icons) with no outer "#PECxxxx"
 * signature — this is what gets embedded inside a .pes file. Returns the matched
 * Brother palette indices, in stitch order, for the caller to reuse if needed. */
export function writePecPayload(w: ByteWriter, pattern: MachinePattern): number[] {
  const colorIndexList = writePecHeader(w, pattern);
  writePecBlock(w, pattern);
  writePecGraphics(w, pattern.threads.length);
  return colorIndexList;
}

/** Standalone .pec file: "#PEC0001" + the payload above. */
export function encodePEC(pattern: MachinePattern): Uint8Array {
  const w = new ByteWriter();
  w.ascii('#PEC0001');
  writePecPayload(w, pattern);
  return w.toUint8Array();
}
