/**
 * Sharper masks than SAM's own 256² output: its logits are upsampled to the mask
 * grid (as SAM does before thresholding), then the mask grows outward into
 * neighbouring pixels that look like its inside nearby. SAM draws conservative
 * outlines at its size, leaving a band of sky around roofs and tree crowns.
 */

/** Max growth in mask texels (512 grid: ~3 x 2 photo pixels each). */
const GROW_STEPS = 6;
/** Window radius for "what the inside looks like nearby", in texels. */
const LOCAL_RADIUS = 6;
/** Max colour distance (RGB 0..1) to that local inside colour to be taken in. */
const COLOR_TOLERANCE = 0.1;

/** Bilinear upsampling of a square `from`² plane to `to`² (pixel centres aligned). */
export function upsample(src: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(to * to);
  const s = from / to;
  for (let y = 0; y < to; y++) {
    const fy = Math.min(from - 1, Math.max(0, (y + 0.5) * s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(from - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < to; x++) {
      const fx = Math.min(from - 1, Math.max(0, (x + 0.5) * s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(from - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * from + x0] * (1 - tx) + src[y0 * from + x1] * tx;
      const b = src[y1 * from + x0] * (1 - tx) + src[y1 * from + x1] * tx;
      out[y * to + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/**
 * Grows mask `p` (0..1, size²) into adjacent texels whose colour (`rgb`, 3 per texel,
 * 0..1) is close to the mask's average colour in a window around them, one texel
 * per step so it stays connected to the mask. Returns 0..1 with a soft 1-texel edge.
 */
export function growToEdges(rgb: Float32Array, p: Float32Array, size: number): Float32Array {
  const n = size * size;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = p[i] >= 0.5 ? 1 : 0;

  // Local average colour of the inside (from SAM's mask, before growing).
  const w = Float32Array.from(inside);
  const weight = boxSum(w, size);
  const mean = [0, 1, 2].map((k) => {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = rgb[i * 3 + k] * inside[i];
    return boxSum(c, size);
  });
  const tol2 = COLOR_TOLERANCE * COLOR_TOLERANCE;
  const looksInside = (i: number) => {
    if (!weight[i]) return false;
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const d = rgb[i * 3 + k] - mean[k][i] / weight[i];
      d2 += d * d;
    }
    return d2 <= tol2;
  };

  for (let step = 0; step < GROW_STEPS; step++) {
    const add: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (inside[i]) continue;
        const touches =
          (x > 0 && inside[i - 1]) || (x < size - 1 && inside[i + 1]) ||
          (y > 0 && inside[i - size]) || (y < size - 1 && inside[i + size]);
        if (touches && looksInside(i)) add.push(i);
      }
    }
    if (!add.length) break;
    for (const i of add) inside[i] = 1;
  }

  // Soft edge: 3x3 average of the grown mask.
  const out = boxSum(Float32Array.from(inside), size, 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cells = (Math.min(size, y + 2) - Math.max(0, y - 1)) * (Math.min(size, x + 2) - Math.max(0, x - 1));
      out[y * size + x] /= cells;
    }
  }
  return out;
}

/** Sum over a (2r+1)² window, clipped at the borders (summed-area table). */
function boxSum(src: Float32Array, size: number, r = LOCAL_RADIUS): Float32Array {
  const w = size + 1;
  const sat = new Float64Array(w * w);
  for (let y = 0; y < size; y++) {
    let row = 0;
    for (let x = 0; x < size; x++) {
      row += src[y * size + x];
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1] + row;
    }
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(size, y + r + 1);
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(size, x + r + 1);
      out[y * size + x] = sat[y1 * w + x1] - sat[y0 * w + x1] - sat[y1 * w + x0] + sat[y0 * w + x0];
    }
  }
  return out;
}
