import type { RGB } from '../types';

function hex(h: number): RGB {
  return { r: (h >> 16) & 0xff, g: (h >> 8) & 0xff, b: h & 0xff };
}

// Janome's 78-color JEF thread chart. Index 0 is a placeholder (never assigned to a stitch).
export const JEF_PALETTE: RGB[] = [
  hex(0x000000),
  hex(0x000000), hex(0xffffff), hex(0xffff17), hex(0xff6600), hex(0x2f5933),
  hex(0x237336), hex(0x65c2c8), hex(0xab5a96), hex(0xf669a0), hex(0xff0000),
  hex(0xb1704e), hex(0x0b2f84), hex(0xe4c35d), hex(0x481a05), hex(0xac9cc7),
  hex(0xfcf294), hex(0xf999b7), hex(0xfab381), hex(0xc9a480), hex(0x970533),
  hex(0xa0b8cc), hex(0x7fc21c), hex(0xe5e5e5), hex(0x889b9b), hex(0x98d6bd),
  hex(0xb2e1e3), hex(0x368ba0), hex(0x4f83ab), hex(0x386a91), hex(0x071650),
  hex(0xf999a2), hex(0xf9676b), hex(0xe3311f), hex(0xe2a188), hex(0xb59474),
  hex(0xe4cf99), hex(0xffcb00), hex(0xe1add4), hex(0xc3007e), hex(0x80004b),
  hex(0x540571), hex(0xb10525), hex(0xcae0c0), hex(0x899856), hex(0x5c941a),
  hex(0x003114), hex(0x5dae94), hex(0x4cbf8f), hex(0x007772), hex(0x595b61),
  hex(0xfffff2), hex(0xb15818), hex(0xcb8a07), hex(0x986c80), hex(0x98692d),
  hex(0x4d3419), hex(0x4c330b), hex(0x33200a), hex(0x523a97), hex(0x0d217e),
  hex(0x1e77ac), hex(0xb2dd53), hex(0xf33689), hex(0xde649e), hex(0x984161),
  hex(0x4c5612), hex(0x4c881f), hex(0xe4de79), hex(0xcb8a1a), hex(0xcba21c),
  hex(0xff9805), hex(0xfcb257), hex(0xffe505), hex(0xf0331f), hex(0x1a842d),
  hex(0x386cae), hex(0xe3c4b4), hex(0xe3ac81),
];

export function nearestJefIndex(color: RGB, excludeIndex: number | null = null): number {
  let bestIdx = 1;
  let bestDist = Infinity;
  for (let i = 1; i < JEF_PALETTE.length; i++) {
    if (i === excludeIndex) continue;
    const p = JEF_PALETTE[i];
    const d = (p.r - color.r) ** 2 + (p.g - color.g) ** 2 + (p.b - color.b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
