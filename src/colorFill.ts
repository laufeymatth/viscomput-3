import type { PackedSplats } from "@sparkjsdev/spark";
import type { Intrinsics } from "./manifest";
import { MASK_SIZE } from "./photoMask";

/** Splats fainter than this don't give a texel its colour. */
const MIN_OPACITY = 0.2;

/** Where each splat lands on a photo's mask grid, and its colour. Built once per scene. */
export interface SplatColors {
  texel: Int32Array; // -1 = outside the photo / behind the camera
  rgb: Float32Array;
}

export function projectColors(splats: PackedSplats, intrinsics: Intrinsics): SplatColors {
  const { fx, fy, cx, cy, width, height } = intrinsics;
  const texel = new Int32Array(splats.numSplats).fill(-1);
  const rgb = new Float32Array(splats.numSplats * 3);
  splats.forEachSplat((i, center, _scales, _quat, opacity, color) => {
    const z = center.z;
    if (z <= 0 || opacity < MIN_OPACITY) return;
    const tx = Math.floor((((fx * center.x) / z + cx) / width) * MASK_SIZE);
    const ty = Math.floor((((fy * center.y) / z + cy) / height) * MASK_SIZE);
    if (tx < 0 || ty < 0 || tx >= MASK_SIZE || ty >= MASK_SIZE) return;
    texel[i] = ty * MASK_SIZE + tx;
    rgb[i * 3] = color.r;
    rgb[i * 3 + 1] = color.g;
    rgb[i * 3 + 2] = color.b;
  });
  return { texel, rgb };
}

/**
 * A colour for every texel (RGBA8): the average splat colour inside `mask`, and
 * outside it the colours extended smoothly from the nearest known ones (push-pull:
 * average down a pyramid, then blend back up), so e.g. a sky's gradient carries on
 * behind a tree. In the splats' own colour values, so it renders like them.
 */
export function fillColorMap(colors: SplatColors, mask: Uint8Array): Uint8Array {
  const n = MASK_SIZE * MASK_SIZE;
  const sum = new Float32Array(n * 3);
  const count = new Float32Array(n);
  for (let i = 0; i < colors.texel.length; i++) {
    const t = colors.texel[i];
    if (t < 0 || mask[t] < 128) continue;
    sum[t * 3] += colors.rgb[i * 3];
    sum[t * 3 + 1] += colors.rgb[i * 3 + 1];
    sum[t * 3 + 2] += colors.rgb[i * 3 + 2];
    count[t]++;
  }
  const rgb = new Float32Array(n * 3);
  const weight = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    if (!count[t]) continue;
    for (let k = 0; k < 3; k++) rgb[t * 3 + k] = sum[t * 3 + k] / count[t];
    weight[t] = 1;
  }
  pushPull(rgb, weight, MASK_SIZE);
  const out = new Uint8Array(n * 4);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) out[t * 4 + k] = Math.round(Math.min(1, Math.max(0, rgb[t * 3 + k])) * 255);
    out[t * 4 + 3] = 255;
  }
  return out;
}

/** Fills texels with weight < 1 from coarser averages, in place. size is a power of two. */
function pushPull(rgb: Float32Array, weight: Float32Array, size: number) {
  if (size <= 1) return;
  const half = size / 2;
  const cRgb = new Float32Array(half * half * 3);
  const cWeight = new Float32Array(half * half);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const c = y * half + x;
      let w = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const f = (y * 2 + dy) * size + x * 2 + dx;
          const fw = weight[f];
          w += fw;
          for (let k = 0; k < 3; k++) cRgb[c * 3 + k] += rgb[f * 3 + k] * fw;
        }
      }
      if (w > 0) for (let k = 0; k < 3; k++) cRgb[c * 3 + k] /= w;
      cWeight[c] = Math.min(1, w);
    }
  }
  pushPull(cRgb, cWeight, half);
  // Blend each fine texel with the coarse level, bilinearly sampled, by how unknown it is.
  for (let y = 0; y < size; y++) {
    const cy = Math.min(half - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(cy), y1 = Math.min(half - 1, y0 + 1), ty = cy - y0;
    for (let x = 0; x < size; x++) {
      const f = y * size + x;
      const w = weight[f];
      if (w >= 1) continue;
      const cx = Math.min(half - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(cx), x1 = Math.min(half - 1, x0 + 1), tx = cx - x0;
      for (let k = 0; k < 3; k++) {
        const a = cRgb[(y0 * half + x0) * 3 + k] * (1 - tx) + cRgb[(y0 * half + x1) * 3 + k] * tx;
        const b = cRgb[(y1 * half + x0) * 3 + k] * (1 - tx) + cRgb[(y1 * half + x1) * 3 + k] * tx;
        rgb[f * 3 + k] = rgb[f * 3 + k] * w + (a * (1 - ty) + b * ty) * (1 - w);
      }
      weight[f] = 1;
    }
  }
}
