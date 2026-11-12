import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { MASK_SIZE } from "./photoMask";

// Self-hosted runtime. GitHub Pages can't send the COOP/COEP headers threads need, so stay single-threaded.
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;

const SAM_INPUT = 1024;
/** Encoder output shapes for SAM 2.1 at 1024x1024, in file order (see tools/sam_embed.py). */
const EMBEDDING_SHAPES = [
  [1, 32, 256, 256],
  [1, 64, 128, 128],
  [1, 256, 64, 64],
] as const;

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
  ) {}

  static async load(opts: {
    decoderUrl: string;
    embeddingsUrl: string;
    imageWidth: number;
    imageHeight: number;
  }): Promise<Segmenter> {
    const dataUrl = `${opts.decoderUrl}_data`;
    const [session, embeddings] = await Promise.all([
      ort.InferenceSession.create(opts.decoderUrl, {
        executionProviders: ["wasm"],
        externalData: [{ path: dataUrl.split("/").pop()!, data: dataUrl }],
      }),
      loadEmbeddings(opts.embeddingsUrl),
    ]);
    return new Segmenter(session, embeddings, opts.imageWidth, opts.imageHeight);
  }

  /** Returns a MASK_SIZE² coverage mask (0..255, row 0 = top of the photo). */
  async segment(points: PromptPoint[]): Promise<Uint8Array> {
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

    // Three candidate masks; take the one the model scores highest.
    const iou = out.iou_scores.data as Float32Array;
    let best = 0;
    for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
    const plane = MASK_SIZE * MASK_SIZE;
    const logits = (out.pred_masks.data as Float32Array).subarray(best * plane, (best + 1) * plane);

    const mask = new Uint8Array(plane);
    for (let i = 0; i < plane; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])));
    return mask;
  }
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
