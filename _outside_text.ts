import opentype from 'opentype.js';
import fs from 'fs';
import { textToObjects } from './src/text/textToObjects';
import { generateObjectStitches } from './src/stitching/engine';
import { pointInPolygon } from './src/stitching/geometry';
import type { Point } from './src/types';

const CS = 10;
function contoursOf(path: any): Point[][] {
  const out: Point[][] = []; let cur: Point[] = []; let st = { x: 0, y: 0 }; let cu = { x: 0, y: 0 };
  const cub = (p0: Point, p1: Point, p2: Point, p3: Point) => { for (let i = 1; i <= CS; i++) { const t = i / CS, m = 1 - t;
    cur.push({ x: m*m*m*p0.x + 3*m*m*t*p1.x + 3*m*t*t*p2.x + t*t*t*p3.x, y: m*m*m*p0.y + 3*m*m*t*p1.y + 3*m*t*t*p2.y + t*t*t*p3.y }); } };
  const qd = (p0: Point, p1: Point, p2: Point) => { for (let i = 1; i <= CS; i++) { const t = i / CS, m = 1 - t;
    cur.push({ x: m*m*p0.x + 2*m*t*p1.x + t*t*p2.x, y: m*m*p0.y + 2*m*t*p1.y + t*t*p2.y }); } };
  for (const c of path.commands) {
    if (c.type === 'M') { if (cur.length > 1) out.push(cur); cur = [{ x: c.x, y: c.y }]; st = { x: c.x, y: c.y }; cu = st; }
    else if (c.type === 'L') { cur.push({ x: c.x, y: c.y }); cu = { x: c.x, y: c.y }; }
    else if (c.type === 'C') { cub(cu, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x, y: c.y }); cu = { x: c.x, y: c.y }; }
    else if (c.type === 'Q') { qd(cu, { x: c.x1, y: c.y1 }, { x: c.x, y: c.y }); cu = { x: c.x, y: c.y }; }
    else if (c.type === 'Z') { if (cur.length > 1) out.push(cur); cur = []; cu = st; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
const insideGlyph = (p: Point, cs: Point[][]) => {
  let n = 0;
  for (const c of cs) if (pointInPolygon(p, c)) n++;
  return n % 2 === 1;
};

const font = opentype.parse(fs.readFileSync(process.argv[2]).buffer as ArrayBuffer);
const text = process.argv[3];
const sizeMm = Number(process.argv[4]);
const scale = sizeMm / font.unitsPerEm;

// Build the whole string's outline once, in the same coordinates textToObjects uses.
const glyphs = font.stringToGlyphs(text);
let cursorX = 0;
const all: Point[][] = [];
for (let i = 0; i < glyphs.length; i++) {
  if (i > 0) cursorX += font.getKerningValue(glyphs[i - 1], glyphs[i]) * scale;
  all.push(...contoursOf(glyphs[i].getPath(cursorX, 0, sizeMm)));
  cursorX += (glyphs[i].advanceWidth ?? 0) * scale;
}

const objects = textToObjects({ text, font, sizeMm, x: 0, y: 0, color: { r: 237, g: 23, b: 31 }, stitchStyle: 'satin-auto' });
let total = 0, outside = 0, worst = 0;
for (const o of objects) {
  const st = generateObjectStitches(o).filter((s) => s.command !== 'TRIM');
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1], b = st[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-6) continue;
    total += d;
    const n = Math.min(14, Math.max(2, Math.ceil(d / 0.15)));
    let out = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      if (!insideGlyph({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, all)) out++;
    }
    const frac = out / n;
    outside += frac * d;
    if (frac > 0.5 && d > worst) worst = d;
  }
}
console.log(`"${text}" ${sizeMm}mm: thread ${total.toFixed(0)}mm, outside the letterform ${outside.toFixed(1)}mm (${((outside / total) * 100).toFixed(1)}%)`);
console.log(`longest stitch lying mostly outside: ${worst.toFixed(2)}mm`);
