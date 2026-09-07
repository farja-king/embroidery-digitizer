import type { RGB } from '../types';

// The 64-color Brother/Babylock thread chart that PEC/PES (and JEF) index colors against.
// Index 0 is reserved/unused; catalog numbers below are Brother's "1".."64".
export const BROTHER_PALETTE: RGB[] = [
  { r: 0, g: 0, b: 0 }, // 0: unused placeholder
  { r: 14, g: 31, b: 124 }, // 1 Prussian Blue
  { r: 10, g: 85, b: 163 }, // 2 Blue
  { r: 0, g: 135, b: 119 }, // 3 Teal Green
  { r: 75, g: 107, b: 175 }, // 4 Cornflower Blue
  { r: 237, g: 23, b: 31 }, // 5 Red
  { r: 209, g: 92, b: 0 }, // 6 Reddish Brown
  { r: 145, g: 54, b: 151 }, // 7 Magenta
  { r: 228, g: 154, b: 203 }, // 8 Light Lilac
  { r: 145, g: 95, b: 172 }, // 9 Lilac
  { r: 158, g: 214, b: 125 }, // 10 Mint Green
  { r: 232, g: 169, b: 0 }, // 11 Deep Gold
  { r: 254, g: 186, b: 53 }, // 12 Orange
  { r: 255, g: 255, b: 0 }, // 13 Yellow
  { r: 112, g: 188, b: 31 }, // 14 Lime Green
  { r: 186, g: 152, b: 0 }, // 15 Brass
  { r: 168, g: 168, b: 168 }, // 16 Silver
  { r: 125, g: 111, b: 0 }, // 17 Russet Brown
  { r: 255, g: 255, b: 179 }, // 18 Cream Brown
  { r: 79, g: 85, b: 86 }, // 19 Pewter
  { r: 0, g: 0, b: 0 }, // 20 Black
  { r: 11, g: 61, b: 145 }, // 21 Ultramarine
  { r: 119, g: 1, b: 118 }, // 22 Royal Purple
  { r: 41, g: 49, b: 51 }, // 23 Dark Gray
  { r: 42, g: 19, b: 1 }, // 24 Dark Brown
  { r: 246, g: 74, b: 138 }, // 25 Deep Rose
  { r: 178, g: 118, b: 36 }, // 26 Light Brown
  { r: 252, g: 187, b: 197 }, // 27 Salmon Pink
  { r: 254, g: 55, b: 15 }, // 28 Vermilion
  { r: 240, g: 240, b: 240 }, // 29 White
  { r: 106, g: 28, b: 138 }, // 30 Violet
  { r: 168, g: 221, b: 196 }, // 31 Seacrest
  { r: 37, g: 132, b: 187 }, // 32 Sky Blue
  { r: 254, g: 179, b: 67 }, // 33 Pumpkin
  { r: 255, g: 243, b: 107 }, // 34 Cream Yellow
  { r: 208, g: 166, b: 96 }, // 35 Khaki
  { r: 209, g: 84, b: 0 }, // 36 Clay Brown
  { r: 102, g: 186, b: 73 }, // 37 Leaf Green
  { r: 19, g: 74, b: 70 }, // 38 Peacock Blue
  { r: 135, g: 135, b: 135 }, // 39 Gray
  { r: 216, g: 204, b: 198 }, // 40 Warm Gray
  { r: 67, g: 86, b: 7 }, // 41 Dark Olive
  { r: 253, g: 217, b: 222 }, // 42 Flesh Pink
  { r: 249, g: 147, b: 188 }, // 43 Pink
  { r: 0, g: 56, b: 34 }, // 44 Deep Green
  { r: 178, g: 175, b: 212 }, // 45 Lavender
  { r: 104, g: 106, b: 176 }, // 46 Wisteria Violet
  { r: 239, g: 227, b: 185 }, // 47 Beige
  { r: 247, g: 56, b: 102 }, // 48 Carmine
  { r: 181, g: 75, b: 100 }, // 49 Amber Red
  { r: 19, g: 43, b: 26 }, // 50 Olive Green
  { r: 199, g: 1, b: 86 }, // 51 Dark Fuchsia
  { r: 254, g: 158, b: 50 }, // 52 Tangerine
  { r: 168, g: 222, b: 235 }, // 53 Light Blue
  { r: 0, g: 103, b: 62 }, // 54 Emerald Green
  { r: 78, g: 41, b: 144 }, // 55 Purple
  { r: 47, g: 126, b: 32 }, // 56 Moss Green
  { r: 255, g: 204, b: 204 }, // 57 Flesh Pink
  { r: 255, g: 217, b: 17 }, // 58 Harvest Gold
  { r: 9, g: 91, b: 166 }, // 59 Electric Blue
  { r: 240, g: 249, b: 112 }, // 60 Lemon Yellow
  { r: 227, g: 243, b: 91 }, // 61 Fresh Green
  { r: 255, g: 153, b: 0 }, // 62 Orange
  { r: 255, g: 240, b: 141 }, // 63 Cream Yellow
  { r: 255, g: 200, b: 200 }, // 64 Applique
];

export function nearestBrotherIndex(color: RGB, excludeIndex: number | null = null): number {
  let bestIdx = 1;
  let bestDist = Infinity;
  for (let i = 1; i < BROTHER_PALETTE.length; i++) {
    if (i === excludeIndex) continue;
    const p = BROTHER_PALETTE[i];
    const d = (p.r - color.r) ** 2 + (p.g - color.g) ** 2 + (p.b - color.b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
