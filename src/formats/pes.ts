import { ByteWriter } from './byteWriter';
import type { MachinePattern } from './model';
import { writePecPayload } from './pec';

/**
 * Writes a "truncated" PES v1 file: the #PES0001 signature, a minimal 14-byte
 * placeholder header, then the PEC payload (header + stitch block + icons).
 * This omits the CEmbOne/CSewSeg vector blocks that Brother's own PE-Design
 * software uses for re-editing a .pes as shapes — those aren't needed to stitch
 * the design, only to reopen and reshape it in Brother's editor later.
 */
export function encodePES(pattern: MachinePattern): Uint8Array {
  const w = new ByteWriter();
  w.ascii('#PES0001');
  w.bytes([0x16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  writePecPayload(w, pattern);
  return w.toUint8Array();
}
