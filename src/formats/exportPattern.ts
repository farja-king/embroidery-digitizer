import type { EmbObject } from '../types';
import { buildPattern } from '../stitching/engine';
import { toMachinePattern } from './model';
import { encodeDST } from './dst';
import { encodeEXP } from './exp';
import { encodeJEF } from './jef';
import { encodePES } from './pes';
import { encodePEC } from './pec';

export type ExportFormat = 'dst' | 'exp' | 'jef' | 'pes' | 'pec';

const MIME = 'application/octet-stream';

export function exportStitchFile(objects: EmbObject[], name: string, format: ExportFormat, trimThresholdMm = 3): void {
  const built = buildPattern(objects, trimThresholdMm);
  if (built.stitches.length === 0) {
    throw new Error('Nothing to export yet — draw at least one stitch object first.');
  }
  const pattern = toMachinePattern(built.stitches, built.threads, name || 'Untitled');

  let bytes: Uint8Array;
  switch (format) {
    case 'dst':
      bytes = encodeDST(pattern);
      break;
    case 'exp':
      bytes = encodeEXP(pattern);
      break;
    case 'jef':
      bytes = encodeJEF(pattern);
      break;
    case 'pes':
      bytes = encodePES(pattern);
      break;
    case 'pec':
      bytes = encodePEC(pattern);
      break;
  }

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(name || 'design')}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'design';
}
