import { ByteWriter } from './byteWriter';
import type { MachinePattern } from './model';

/** Melco/Bernina Expanded format: a flat stream of signed dx,dy byte pairs (0.1mm units),
 * with 0x80-prefixed 4-byte markers for jump/trim/color-change. No header. */
export function encodeEXP(pattern: MachinePattern): Uint8Array {
  const w = new ByteWriter();
  let xx = 0;
  let yy = 0;

  for (const s of pattern.stitches) {
    const dx = Math.round(s.x - xx);
    const dy = Math.round(s.y - yy);

    if (s.command === 'STITCH' || s.command === 'JUMP') {
      xx += dx;
      yy += dy;
    }

    if (Math.abs(dx) > 127 || Math.abs(dy) > 127) {
      throw new Error(`EXP stitch delta out of range: dx=${dx} dy=${dy}`);
    }

    switch (s.command) {
      case 'STITCH':
        w.bytes([dx & 0xff, -dy & 0xff]);
        break;
      case 'JUMP':
        w.bytes([0x80, 0x04]);
        w.bytes([dx & 0xff, -dy & 0xff]);
        break;
      case 'TRIM':
        w.bytes([0x80, 0x80, 0x07, 0x00]);
        break;
      case 'COLOR_CHANGE':
        w.bytes([0x80, 0x01, 0x00, 0x00]);
        break;
      case 'END':
        break;
    }
  }

  return w.toUint8Array();
}
