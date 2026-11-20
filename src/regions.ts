import type { PackedSplats } from "@sparkjsdev/spark";

/** A rectangle of the source photo, as fractions: 0 = top/left, 1 = bottom/right. */
export interface Region {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const DIGITS = 3;

/** URL form: `top,left,bottom,right` per region, regions joined by `_`. */
export function formatRegions(regions: Region[]): string {
  return regions.map((r) => [r.top, r.left, r.bottom, r.right].map((v) => v.toFixed(DIGITS)).join(",")).join("_");
}

export function parseRegions(value: string | null): Region[] {
  if (!value) return [];
  return value
    .split("_")
    .map((part) => part.split(",").map(Number))
    .filter((v) => v.length === 4 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
    .map(([top, left, bottom, right]) => ({
      top: Math.min(top, bottom),
      left: Math.min(left, right),
      bottom: Math.max(top, bottom),
      right: Math.max(left, right),
    }))
    .filter((r) => r.bottom > r.top && r.right > r.left);
}

/**
 * Splits a single-layer SHARP splat set (one splat per pixel of a W×W grid, row 0
 * = top of the photo, as written by scripts/spz-front-layer.mjs) into the splats
 * inside any of `regions` and the rest.
 */
export function splitByRegions(splats: PackedSplats, regions: Region[]) {
  const n = splats.numSplats;
  const w = Math.round(Math.sqrt(n));
  if (w * w !== n) throw new Error(`Region split needs one splat per pixel of a square grid; got ${n} splats`);

  const inside = new Uint32Array(n);
  const outside = new Uint32Array(n);
  let ni = 0, no = 0;
  for (let i = 0; i < n; i++) {
    const row = (Math.floor(i / w) + 0.5) / w;
    const col = ((i % w) + 0.5) / w;
    const hit = regions.some((r) => row >= r.top && row < r.bottom && col >= r.left && col < r.right);
    if (hit) inside[ni++] = i;
    else outside[no++] = i;
  }
  return {
    inside: splats.extractSplats(inside.subarray(0, ni), false),
    outside: splats.extractSplats(outside.subarray(0, no), false),
  };
}
