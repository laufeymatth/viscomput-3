import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import type { Intrinsics } from "./manifest";

/** SAM's low-res mask resolution; it covers the whole photo (SAM 2.1 resizes without padding). */
export const MASK_SIZE = 256;

/**
 * How far behind a selected object's front surface still counts as the object,
 * as a fraction of its distance. Farther splats are SHARP's guess at what's
 * hidden behind it, which must not come along.
 */
const DEPTH_BAND = 0.2;

/**
 * A soft mask over a source photo plus the selected object's front depth, used
 * to show or hide splats by where their centre projects into that photo. Works
 * because SHARP splats are generated per pixel from a camera at the origin, so
 * the projection is a plain pinhole.
 */
export class PhotoMask {
  private readonly coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private readonly depth = new Float32Array(MASK_SIZE * MASK_SIZE);
  private readonly coverageTexture: THREE.DataTexture;
  private readonly depthTexture: THREE.DataTexture;

  constructor() {
    // R8 + linear filtering for soft edges; supported everywhere in WebGL2.
    this.coverageTexture = new THREE.DataTexture(this.coverage, MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.coverageTexture.magFilter = this.coverageTexture.minFilter = THREE.LinearFilter;
    // Depth must not blend with empty (0) texels, so nearest; R32F nearest is core WebGL2.
    this.depthTexture = new THREE.DataTexture(this.depth, MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.FloatType);
    this.depthTexture.magFilter = this.depthTexture.minFilter = THREE.NearestFilter;
    for (const t of [this.coverageTexture, this.depthTexture]) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
    }
  }

  /** coverage: 0..255, depth: front depth per texel (0 = none). Row 0 = top of the photo. */
  set(coverage: Uint8Array, depth: Float32Array) {
    this.coverage.set(coverage);
    this.depth.set(depth);
    this.coverageTexture.needsUpdate = true;
    this.depthTexture.needsUpdate = true;
  }

  /**
   * "object": keep only splats that are the selected object (inside the mask and
   * not behind it). "rest": hide splats inside the mask up to the object's back,
   * keeping what lies behind it so moving the camera reveals background, not a hole.
   */
  modifier(intrinsics: Intrinsics, keep: "object" | "rest") {
    const { fx, fy, cx, cy, width, height } = intrinsics;
    const f = (v: number) => v.toFixed(6);
    const shader = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, coverage: "sampler2D", depth: "sampler2D" },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) =>
        dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          vec3 c = ${inputs.gsplat}.center;
          float sel = 0.0;
          if (c.z > 0.0) {
            vec2 uv = vec2((${f(fx)} * c.x / c.z + ${f(cx)}) / ${f(width)},
                           (${f(fy)} * c.y / c.z + ${f(cy)}) / ${f(height)});
            if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
              float m = smoothstep(0.3, 0.7, texture(${inputs.coverage}, uv).r);
              float front = texture(${inputs.depth}, uv).r;
              float back = front * ${f(1 + DEPTH_BAND)};
              float inDepth = front > 0.0 ? 1.0 - smoothstep(back, back * 1.05, c.z) : 0.0;
              sel = m * inDepth;
            }
          }
          ${outputs.gsplat}.rgba.a *= ${keep === "object" ? "sel" : "1.0 - sel"};
        `),
    });
    const coverage = dyno.dynoSampler2D(this.coverageTexture);
    const depth = dyno.dynoSampler2D(this.depthTexture);
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => ({
      gsplat: shader.apply({ gsplat, coverage, depth }).gsplat,
    }));
  }
}
