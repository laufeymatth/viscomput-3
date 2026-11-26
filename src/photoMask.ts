import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import type { Intrinsics } from "./manifest";

/**
 * Mask grid resolution; it covers the whole photo (SAM 2.1 resizes without padding).
 * Twice SAM's own 256² output: masks are upsampled and snapped to the photo's edges
 * (maskRefine.ts).
 */
export const MASK_SIZE = 512;

/**
 * How far behind a selected object's front surface still counts as the object,
 * as a fraction of its distance. Farther splats are SHARP's guess at what's
 * hidden behind it, which must not come along.
 */
export const DEPTH_BAND = 0.2;

/**
 * "rest" only hides the other scene's splats from this fraction in front of the
 * object's front surface. Anything nearer is something standing in front of the
 * added object (e.g. a person nearer the camera) and must stay, covering it.
 */
const NEAR_BAND = 0.15;

/** How far past the photo's edges (fraction of its size) splats still use the edge of the mask. */
export const EDGE_MARGIN = 0.3;

/**
 * Replace parts (e.g. sky) in the target scene, on the TARGET photo's grid: the
 * target's own splats in its matching segment are repainted, nothing is added. No
 * depth test: the segment is the target's own (its sky), and SHARP spreads sky
 * splats over a wide range of depths.
 */
export interface ReplaceMask {
  /** Where the target's splats are repainted with `color` (its whole matching segment). */
  fill: Uint8Array;
  /** RGBA8 per texel: the source's colours there, extended smoothly into holes. */
  color: Uint8Array;
}

/**
 * A soft mask over a source photo plus the selected object's front depth, used
 * to show or hide splats by where their centre projects into that photo. Works
 * because SHARP splats are generated per pixel from a camera at the origin, so
 * the projection is a plain pinhole.
 */
export class PhotoMask {
  private readonly coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private readonly depth = new Float32Array(MASK_SIZE * MASK_SIZE);
  private readonly fill = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private readonly color = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  private readonly textures: THREE.DataTexture[];

  constructor() {
    // Masks and colours: 8-bit + linear filtering for soft edges; supported everywhere in WebGL2.
    // Depth must not blend with empty (0) texels, so nearest; R32F nearest is core WebGL2.
    const linear = (data: Uint8Array, format: THREE.PixelFormat) => {
      const t = new THREE.DataTexture(data, MASK_SIZE, MASK_SIZE, format, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      return t;
    };
    const depth = new THREE.DataTexture(this.depth, MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.FloatType);
    depth.magFilter = depth.minFilter = THREE.NearestFilter;
    this.textures = [
      linear(this.coverage, THREE.RedFormat),
      depth,
      linear(this.fill, THREE.RedFormat),
      linear(this.color, THREE.RGBAFormat),
    ];
    for (const t of this.textures) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
    }
  }

  /**
   * coverage: 0..255, depth: front depth per texel (0 = none), both on the source
   * photo's grid. Row 0 = top of the photo.
   * replace: see ReplaceMask; only read by "rest".
   */
  set(coverage: Uint8Array, depth: Float32Array, replace?: ReplaceMask) {
    this.coverage.set(coverage);
    this.depth.set(depth);
    if (replace) {
      this.fill.set(replace.fill);
      this.color.set(replace.color);
    } else {
      this.fill.fill(0);
    }
    for (const t of this.textures) t.needsUpdate = true;
  }

  /**
   * "object": keep only splats that are the selected object (inside the mask and
   * not behind it). "rest": hide splats inside the mask around the object's depth
   * (from just in front of it to its back), keeping what lies behind it so moving the
   * camera reveals background, not a hole, and what stands clearly in front of it.
   * "rest" also applies the replace masks (see set()); for that, intrinsics must be
   * the target photo's, which they are laid out on.
   */
  modifier(intrinsics: Intrinsics, keep: "object" | "rest") {
    const { fx, fy, cx, cy, width, height } = intrinsics;
    const f = (v: number) => v.toFixed(6);
    const shader = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        coverage: "sampler2D",
        depth: "sampler2D",
        fill: "sampler2D",
        color: "sampler2D",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) =>
        dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          vec3 c = ${inputs.gsplat}.center;
          float sel = 0.0;
          if (c.z > 0.0) {
            vec2 uv = vec2((${f(fx)} * c.x / c.z + ${f(cx)}) / ${f(width)},
                           (${f(fy)} * c.y / c.z + ${f(cy)}) / ${f(height)});
            // SHARP puts some splats past the photo's edges (up to ~20%); they take the
            // nearest edge texel, so e.g. a selected sky continues out there in both scenes.
            vec2 outside = abs(uv - clamp(uv, 0.0, 1.0));
            uv = clamp(uv, 0.0, 1.0);
            if (max(outside.x, outside.y) <= ${f(EDGE_MARGIN)}) {
              float m = smoothstep(0.3, 0.7, texture(${inputs.coverage}, uv).r);
              float front = texture(${inputs.depth}, uv).r;
              float back = front * ${f(1 + DEPTH_BAND)};
              float band = front > 0.0 ? 1.0 - smoothstep(back, back * 1.05, c.z) : 0.0;
              ${keep === "object"
                ? `sel = m * band;`
                : `float near = front * ${f(1 - NEAR_BAND)};
              sel = m * band * smoothstep(near * 0.95, near, c.z);
              float fillAmount = smoothstep(0.3, 0.7, texture(${inputs.fill}, uv).r);
              ${outputs.gsplat}.rgba.rgb = mix(${outputs.gsplat}.rgba.rgb, texture(${inputs.color}, uv).rgb, fillAmount);`}
            }
          }
          ${outputs.gsplat}.rgba.a *= ${keep === "object" ? "sel" : "1.0 - sel"};
        `),
    });
    const [coverage, depth, fill, color] = this.textures.map((t) => dyno.dynoSampler2D(t));
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => ({
      gsplat: shader.apply({ gsplat, coverage, depth, fill, color }).gsplat,
    }));
  }
}
