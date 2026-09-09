import { generateObjectStitches } from './src/stitching/engine';
import { fillUnderlay, autoUnderlayType } from './src/stitching/underlay';
import { flattenPath, pointInPolygon } from './src/stitching/geometry';
import { defaultObject } from './src/state/store';
import type { EmbObject, PathPoint, Point } from './src/types';
import fs from 'fs';

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).objects[0];
const poly: Point[] = flattenPath(raw.points as PathPoint[], true);

// Dominant direction of a point path, matching how the Hatch files were measured.
function dominant(pts: Point[]): number {
  const hist = new Map<number, number>();
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    let a = ((Math.atan2(dy, dx) * 180) / Math.PI) % 180;
    if (a < 0) a += 180;
    const k = (Math.round(a / 5) * 5) % 180;
    hist.set(k, (hist.get(k) ?? 0) + d);
  }
  return [...hist.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

console.log('fill  underlay  offset   |  fill travel  detours  longest  outside');
for (const angle of [0, 25, 35, 60, 90, 155, 165]) {
  const ul = fillUnderlay(poly, angle, { mode: 'manual', type: 'tatami', spacing: 2.5 }, 'tatami', raw.fill.startPoint);
  const ulAngle = dominant(ul);
  let offset = (ulAngle - angle) % 180;
  if (offset < 0) offset += 180;

  const o: EmbObject = defaultObject('fill', raw.points as PathPoint[], raw.color);
  o.fill = { ...o.fill, ...JSON.parse(JSON.stringify(raw.fill)), angle };
  o.fill.underlay = { pass1: { mode: 'manual', type: 'none', spacing: 2.5 }, pass2: { mode: 'manual', type: 'none', spacing: 2.5 } };
  const st = generateObjectStitches(o).filter((s) => s.command !== 'TRIM');
  let total = 0, travel = 0, runLen = 0, longest = 0, detours = 0, outside = 0;
  for (let i = 1; i < st.length; i++) {
    const dx = st[i].x - st[i - 1].x, dy = st[i].y - st[i - 1].y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    total += d;
    let a = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI - angle) % 180;
    if (a > 90) a = 180 - a;
    if (a > 25) { travel += d; runLen += d; if (runLen > longest) longest = runLen; }
    else { if (runLen > 3) detours++; runLen = 0; }
    const n = Math.min(10, Math.max(2, Math.ceil(d / 0.5)));
    let out = 0;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      if (!pointInPolygon({ x: st[i - 1].x + dx * t, y: st[i - 1].y + dy * t }, poly)) out++;
    }
    outside += (out / n) * d;
  }
  if (runLen > 3) detours++;
  console.log(
    `${String(angle).padStart(4)}  ${String(ulAngle).padStart(8)}  ${String(offset).padStart(6)}   |  ` +
    `${((travel / total) * 100).toFixed(1).padStart(9)}%  ${String(detours).padStart(7)}  ${longest.toFixed(0).padStart(6)}mm  ${outside.toFixed(0).padStart(5)}mm`,
  );
}
console.log('\nHatch, measured: fill 155/underlay 20, fill 165/underlay 30, fill 35/underlay 80 -- offset 45 every time');
console.log('Hatch fill travel: 0.6% on both Pac-Men (2 and 4 detours)');
console.log('auto underlay for this shape:', autoUnderlayType(Object.assign(defaultObject('fill', raw.points as PathPoint[], raw.color), { fill: raw.fill }) as EmbObject, 1),
  '/', autoUnderlayType(Object.assign(defaultObject('fill', raw.points as PathPoint[], raw.color), { fill: raw.fill }) as EmbObject, 2));
