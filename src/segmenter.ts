import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { growToEdges, upsample } from "./maskRefine";
import { MASK_SIZE } from "./photoMask";

// Self-hosted runtime. GitHub Pages can't send the COOP/COEP headers threads need, so stay single-threaded.
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;

/** SAM 2.1 prompt decoder, served from public/. */
export const DECODER_URL = new URL(
  "models/sam2.1-base-plus/prompt_encoder_mask_decoder.onnx",
  new URL(import.meta.env.BASE_URL, location.href),
).href;

const SAM_INPUT = 1024;
/** Encoder output shapes for SAM 2.1 at 1024x1024, in file order (see tools/sam_embed.py). */
const EMBEDDING_SHAPES = [
  [1, 32, 256, 256],
  [1, 64, 128, 128],
  [1, 256, 64, 64],
] as const;

export interface SegmentOptions {
  /**
   * Grow the mask out into neighbouring pixels that look like its inside (maskRefine.ts).
   * Closes SAM's gap between a sky and the roofs and trees around it, but spills into
   * the surroundings of other things, so only for sky.
   */
  growToEdges?: boolean;
}

export interface PromptPoint {
  /** Photo pixel coordinates. */
  x: number;
  y: number;
  /** true = include this spot, false = exclude it. */
  positive: boolean;
}

/**
 * SAM 2.1 mask decoder running in the browser against embeddings that were
 * precomputed offline, so each click costs only the small decoder.
 */
export class Segmenter {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly embeddings: ort.Tensor[],
    private readonly imageWidth: number,
    private readonly imageHeight: number,
    /** The photo's colours on the mask grid (RGB 0..1), to grow sky masks to their edges (null: never). */
    private readonly guide: Float32Array | null,
  ) {}

  static async load(opts: {
    decoderUrl: string;
    embeddingsUrl: string;
    imageWidth: number;
    imageHeight: number;
    /** The photo itself: mask edges grow out to its real edges. */
    imageUrl?: string;
  }): Promise<Segmenter> {
    const dataUrl = `${opts.decoderUrl}_data`;
    const [session, embeddings, guide] = await Promise.all([
      ort.InferenceSession.create(opts.decoderUrl, {
        executionProviders: ["wasm"],
        externalData: [{ path: dataUrl.split("/").pop()!, data: dataUrl }],
      }),
      loadEmbeddings(opts.embeddingsUrl),
      opts.imageUrl ? loadGuide(opts.imageUrl).catch(() => null) : null,
    ]);
    return new Segmenter(session, embeddings, opts.imageWidth, opts.imageHeight, guide);
  }

  /** Returns a MASK_SIZE² coverage mask (0..255, row 0 = top of the photo): the candidate SAM scores highest. */
  async segment(points: PromptPoint[], opts: SegmentOptions = {}): Promise<Uint8Array> {
    const { masks, scores } = await this.segmentAll(points, opts);
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return masks[best];
  }

  /** All of SAM's candidate masks for these points (whole / part / subpart), with its scores. */
  async segmentAll(points: PromptPoint[], opts: SegmentOptions = {}): Promise<{ masks: Uint8Array[]; scores: Float32Array }> {
    const sx = SAM_INPUT / this.imageWidth;
    const sy = SAM_INPUT / this.imageHeight;
    const coords = new Float32Array(points.flatMap((p) => [p.x * sx, p.y * sy]));
    const labels = BigInt64Array.from(points, (p) => (p.positive ? 1n : 0n));

    const out = await this.session.run({
      input_points: new ort.Tensor("float32", coords, [1, 1, points.length, 2]),
      input_labels: new ort.Tensor("int64", labels, [1, 1, points.length]),
      input_boxes: new ort.Tensor("float32", new Float32Array(0), [1, 0, 4]),
      "image_embeddings.0": this.embeddings[0],
      "image_embeddings.1": this.embeddings[1],
      "image_embeddings.2": this.embeddings[2],
    });

    const scores = out.iou_scores.data as Float32Array;
    const plane = SAM_MASK * SAM_MASK;
    const all = out.pred_masks.data as Float32Array;
    const masks = Array.from(scores, (_, k) => {
      // Upsample the logits (not the 0..1 mask), as SAM does: sharper edges.
      const logits = upsample(all.subarray(k * plane, (k + 1) * plane), SAM_MASK, MASK_SIZE);
      let p: Float32Array = logits.map((l) => 1 / (1 + Math.exp(-l)));
      if (opts.growToEdges && this.guide) p = growToEdges(this.guide, p, MASK_SIZE);
      return Uint8Array.from(p, (v) => Math.round(v * 255));
    });
    return { masks, scores };
  }
}

/** SAM's own mask output size. */
const SAM_MASK = 256;

/** The photo's colours (RGB 0..1), squeezed onto the square mask grid like the masks. */
async function loadGuide(url: string): Promise<Float32Array> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = MASK_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, MASK_SIZE, MASK_SIZE);
  const px = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
  const out = new Float32Array(MASK_SIZE * MASK_SIZE * 3);
  for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = px[i * 4 + k] / 255;
  return out;
}

async function loadEmbeddings(url: string): Promise<ort.Tensor[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load segmentation data (${res.status})`);
  const halves = new Uint16Array(await res.arrayBuffer());
  const floats = halfToFloat32(halves);

  const tensors: ort.Tensor[] = [];
  let offset = 0;
  for (const shape of EMBEDDING_SHAPES) {
    const n = shape.reduce<number>((a, b) => a * b, 1);
    tensors.push(new ort.Tensor("float32", floats.subarray(offset, offset + n), [...shape]));
    offset += n;
  }
  if (offset !== floats.length) throw new Error("Segmentation data has an unexpected size");
  return tensors;
}

function halfToFloat32(src: Uint16Array): Float32Array {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    table[h] =
      exp === 0 ? sign * 2 ** -14 * (frac / 1024)
      : exp === 31 ? (frac ? NaN : sign * Infinity)
      : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = table[src[i]];
  return out;
}
