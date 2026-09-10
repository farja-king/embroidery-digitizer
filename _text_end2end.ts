import opentype from 'opentype.js';
import fs from 'fs';
import { textToObjects } from './src/text/textToObjects';
import { buildPattern } from './src/stitching/engine';

const font = opentype.parse(fs.readFileSync(process.argv[2]).buffer as ArrayBuffer);
const text = process.argv[3];
const sizeMm = Number(process.argv[4] ?? 20);
const objects = textToObjects({ text, font, sizeMm, x: 0, y: 0, color: { r: 237, g: 23, b: 31 }, stitchStyle: 'satin-auto' });
console.log(`"${text}" -> ${objects.length} objects`);
for (const o of objects) {
  const cols = o.kind === 'satin' ? (o.satin.columnBreaks?.length ?? 0) + 1 : 0;
  console.log(`  ${o.name.padEnd(22)} ${o.kind.padEnd(6)} ${o.points.length} pts` + (cols ? `, ${cols} columns` : ''));
}
const { stitches } = buildPattern(objects, 3);
const trims = stitches.filter((s) => s.command === 'TRIM').length;
let mx = 0;
for (let i = 1; i < stitches.length; i++) {
  if (stitches[i].command !== 'STITCH' || stitches[i - 1].command !== 'STITCH') continue;
  mx = Math.max(mx, Math.hypot(stitches[i].x - stitches[i - 1].x, stitches[i].y - stitches[i - 1].y));
}
console.log(`\nstitches ${stitches.length}, TRIMs ${trims}, longest ordinary stitch ${mx.toFixed(2)}mm`);
