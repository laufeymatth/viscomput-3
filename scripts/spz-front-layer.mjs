// Usage: node scripts/spz-front-layer.mjs <in.spz> <out.spz>  (halves the splat count)
//
// SHARP writes two splats per pixel: two W×H grids back to back, where splat i
// and splat i + N/2 lie along the same pixel ray. Neither grid is consistently
// the front one, so per pixel keep whichever splat is nearer the camera. Halves
// the splat count; what's lost is mostly the background SHARP guessed behind objects,
// which only shows when the head moves sideways.
//
// Only handles SPZ v2 without spherical harmonics (what SHARP + ply-to-spz produce).
import fs from "node:fs";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const [input, output] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!input || !output) {
  console.error("Usage: node scripts/spz-front-layer.mjs <in.spz> <out.spz> [--merge-ratio 1.2] [--geometry near|dominant]");
  process.exit(1);
}
const ratioFlag = args.indexOf("--merge-ratio");

const src = zlib.gunzipSync(fs.readFileSync(input));
const version = src.readUInt32LE(4);
const n = src.readUInt32LE(8);
const shDegree = src[12];
const fractionalBits = src[13];
if (version !== 2 || shDegree !== 0 || n % 2 !== 0) {
  throw new Error(`Unsupported SPZ: version ${version}, shDegree ${shDegree}, ${n} splats`);
}
// SPZ v2 is structure-of-arrays: positions 9, alpha 1, color 3, scale 3, rotation 3 bytes per splat.
const fields = [["position", 9], ["alpha", 1], ["color", 3], ["scale", 3], ["rotation", 3]];
const HEADER = 16;
if (src.length !== HEADER + n * 19) throw new Error("Unexpected SPZ size for v2 / SH0");

const half = n / 2;
const z = (i) => {
  const o = HEADER + i * 9 + 6;
  let v = src[o] | (src[o + 1] << 8) | (src[o + 2] << 16);
  if (v & 0x800000) v |= ~0xffffff;
  return v / (1 << fractionalBits);
};

// Far/near depth ratio below which the pair counts as one surface and is merged.
const MERGE_DEPTH_RATIO = ratioFlag >= 0 ? Number(args[ratioFlag + 1]) : 1.2;
// Whose shape (position, scale, rotation) a merged splat gets: "near" (default)
// or "dominant" = the more opaque of the pair. SHARP often pairs a large faint
// splat with a small solid one; giving the combined opacity to the large one
// makes close objects look blobby and too opaque.
const geometryFlag = args.indexOf("--geometry");
const GEOMETRY = geometryFlag >= 0 ? args[geometryFlag + 1] : "near";

const srcAlpha = HEADER + n * 9, srcColor = srcAlpha + n, srcScale = srcColor + n * 3;
const alpha = (i) => src[srcAlpha + i] / 255;
const size = (i) => src[srcScale + i * 3] + src[srcScale + i * 3 + 1] + src[srcScale + i * 3 + 2]; // log-scale bytes

// Per pixel: the nearer splat (behind-camera splats count as far), the other one,
// whether they merge, and which one supplies the shape.
const nearOf = new Uint32Array(half), farOf = new Uint32Array(half), shapeOf = new Uint32Array(half);
const merge = new Uint8Array(half);
let merged = 0, bigFaintNear = 0;
for (let i = 0; i < half; i++) {
  const a = z(i), b = z(i + half);
  const da = a > 0 ? a : Infinity, db = b > 0 ? b : Infinity;
  const near = da <= db ? i : i + half, far = near === i ? i + half : i;
  const zn = z(near), zf = z(far);
  nearOf[i] = near;
  farOf[i] = far;
  merge[i] = zn > 0 && zf > 0 && zf / zn < MERGE_DEPTH_RATIO ? 1 : 0;
  shapeOf[i] = merge[i] && GEOMETRY === "dominant" && alpha(far) > alpha(near) ? far : near;
  if (merge[i]) {
    merged++;
    if (size(near) > size(far) && alpha(near) < alpha(far)) bigFaintNear++;
  }
}

// SPZ v2 is structure-of-arrays. Shape fields come from shapeOf; alpha and colour
// from the near splat, then overwritten below for merged pairs.
const out = Buffer.alloc(HEADER + half * 19);
src.copy(out, 0, 0, HEADER);
out.writeUInt32LE(half, 8);
let srcOffset = HEADER, dstOffset = HEADER;
for (const [name, bytes] of fields) {
  const from = name === "alpha" || name === "color" ? nearOf : shapeOf;
  for (let j = 0; j < half; j++) {
    src.copy(out, dstOffset + j * bytes, srcOffset + from[j] * bytes, srcOffset + (from[j] + 1) * bytes);
  }
  srcOffset += n * bytes;
  dstOffset += half * bytes;
}

// Dropping the far splat outright leaves the near one see-through: SHARP stacks
// the pair to build up opacity. For merged pairs, "over"-composite the two. SPZ
// alpha bytes are linear opacity and colour bytes are linear in the SH DC term,
// so blending bytes is exact.
const outAlpha = HEADER + half * 9, outColor = outAlpha + half;
for (let j = 0; j < half; j++) {
  if (!merge[j]) continue;
  const near = nearOf[j], far = farOf[j];
  const a1 = alpha(near), a2 = alpha(far);
  const a = 1 - (1 - a1) * (1 - a2);
  if (a <= 0) continue;
  const w1 = a1 / a, w2 = ((1 - a1) * a2) / a;
  out[outAlpha + j] = Math.round(a * 255);
  for (let k = 0; k < 3; k++) {
    const c = w1 * src[srcColor + near * 3 + k] + w2 * src[srcColor + far * 3 + k];
    out[outColor + j * 3 + k] = Math.max(0, Math.min(255, Math.round(c)));
  }
}

fs.writeFileSync(output, zlib.gzipSync(out));
console.log(
  `${input} -> ${output}: ${n} -> ${half} splats, ${((100 * merged) / half).toFixed(1)}% merged (shape: ${GEOMETRY}); ` +
    `in ${((100 * bigFaintNear) / Math.max(1, merged)).toFixed(0)}% of merged pairs the near splat is the larger, fainter one`,
);
