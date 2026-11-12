import type { PackedSplats } from "@sparkjsdev/spark";
import type { Intrinsics } from "./manifest";
import { MASK_SIZE } from "./photoMask";

/** Splats fainter than this don't define an object's surface. */
const MIN_SURFACE_OPACITY = 0.2;
/** Texels at least this covered count as part of the selection. */
const COVERED = 128;
/** Passes of 3x3 growth to give depth to covered texels that no splat landed in. */
const FILL_PASSES = 3;

/**
 * Where each splat of a SHARP reconstruction lands on the mask grid of its
 * source photo, and how far away it is. Built once, reused for every part.
 */
export class SplatProjection {
  private constructor(
    private readonly texel: Int32Array, // -1 = outside the photo / behind the camera
    private readonly depth: Float32Array,
  ) {}

  static build(splats: PackedSplats, intrinsics: Intrinsics): SplatProjection {
    const { fx, fy, cx, cy, width, height } = intrinsics;
    const texel = new Int32Array(splats.numSplats).fill(-1);
    const depth = new Float32Array(splats.numSplats);
    splats.forEachSplat((i, center, _scales, _quat, opacity) => {
      const z = center.z;
      if (z <= 0 || opacity < MIN_SURFACE_OPACITY) return;
      const tx = Math.floor(((fx * center.x) / z + cx) / width * MASK_SIZE);
      const ty = Math.floor(((fy * center.y) / z + cy) / height * MASK_SIZE);
      if (tx < 0 || ty < 0 || tx >= MASK_SIZE || ty >= MASK_SIZE) return;
      texel[i] = ty * MASK_SIZE + tx;
      depth[i] = z;
    });
    return new SplatProjection(texel, depth);
  }

  /**
   * Per mask texel, depth of the nearest surface inside the selection (0 = none).
   * This is the selected object's front; whatever SHARP put behind it (its
   * guess at the hidden background) is farther away and gets left out.
   */
  frontDepth(coverage: Uint8Array): Float32Array {
    const front = new Float32Array(MASK_SIZE * MASK_SIZE);
    for (let i = 0; i < this.texel.length; i++) {
      const t = this.texel[i];
      if (t < 0 || coverage[t] < COVERED) continue;
      const z = this.depth[i];
      if (front[t] === 0 || z < front[t]) front[t] = z;
    }
    return fillGaps(front, coverage);
  }
}

/** Covered texels with no splat of their own take the nearest neighbouring depth. */
function fillGaps(front: Float32Array, coverage: Uint8Array): Float32Array {
  let cur = front;
  for (let pass = 0; pass < FILL_PASSES; pass++) {
    const next = cur.slice();
    for (let y = 0; y < MASK_SIZE; y++) {
      for (let x = 0; x < MASK_SIZE; x++) {
        const t = y * MASK_SIZE + x;
        if (cur[t] !== 0 || coverage[t] === 0) continue;
        let best = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= MASK_SIZE || ny >= MASK_SIZE) continue;
            const z = cur[ny * MASK_SIZE + nx];
            if (z !== 0 && (best === 0 || z < best)) best = z;
          }
        }
        next[t] = best;
      }
    }
    cur = next;
  }
  return cur;
}
