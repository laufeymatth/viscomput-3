import type { PackedSplats } from "@sparkjsdev/spark";
import type { Intrinsics } from "./manifest";
import { DEPTH_BAND, EDGE_MARGIN, MASK_SIZE } from "./photoMask";

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
    /** -1 = behind the camera or far outside the photo; just outside it, the nearest edge texel (as the shader). */
    private readonly texel: Int32Array,
    private readonly depth: Float32Array,
    /** 1 = inside the photo and opaque enough to define a surface (frontDepth uses only these). */
    private readonly surface: Uint8Array,
  ) {}

  static build(splats: PackedSplats, intrinsics: Intrinsics): SplatProjection {
    const { fx, fy, cx, cy, width, height } = intrinsics;
    const texel = new Int32Array(splats.numSplats).fill(-1);
    const depth = new Float32Array(splats.numSplats);
    const surface = new Uint8Array(splats.numSplats);
    splats.forEachSplat((i, center, _scales, _quat, opacity) => {
      const z = center.z;
      if (z <= 0) return;
      const u = ((fx * center.x) / z + cx) / width;
      const v = ((fy * center.y) / z + cy) / height;
      const outside = Math.max(-u, u - 1, -v, v - 1, 0);
      if (outside > EDGE_MARGIN) return;
      const tx = Math.min(MASK_SIZE - 1, Math.max(0, Math.floor(u * MASK_SIZE)));
      const ty = Math.min(MASK_SIZE - 1, Math.max(0, Math.floor(v * MASK_SIZE)));
      texel[i] = ty * MASK_SIZE + tx;
      depth[i] = z;
      surface[i] = outside === 0 && opacity >= MIN_SURFACE_OPACITY ? 1 : 0;
    });
    return new SplatProjection(texel, depth, surface);
  }

  /**
   * Indices of the splats the "object" shader can show for this mask and depth
   * (see PhotoMask): a small set to copy into the other scene instead of all of them.
   */
  select(coverage: Uint8Array, front: Float32Array): Uint32Array {
    const minCoverage = 0.3 * 255; // the shader's smoothstep starts there
    const out: number[] = [];
    for (let i = 0; i < this.texel.length; i++) {
      const t = this.texel[i];
      if (t < 0 || coverage[t] < minCoverage || front[t] <= 0) continue;
      if (this.depth[i] <= front[t] * (1 + DEPTH_BAND) * 1.05) out.push(i);
    }
    return Uint32Array.from(out);
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
      if (t < 0 || !this.surface[i] || coverage[t] < COVERED) continue;
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
