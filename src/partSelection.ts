import * as THREE from "three";
import { PackedSplats, SplatMesh } from "@sparkjsdev/spark";
import type { Intrinsics, Manifest } from "./manifest";
import { fillColorMap, projectColors, type SplatColors } from "./colorFill";
import { MASK_SIZE, PhotoMask, type ReplaceMask } from "./photoMask";
import type { PromptPoint, Segmenter } from "./segmenter";
import { SplatProjection } from "./splatProjection";

/**
 * Share of a replace part's mask that the target photo's own segment must cover;
 * less means the same points picked something else there (a branch instead of sky).
 */
const MIN_MATCH = 0.5;

interface Part {
  coverage: Uint8Array;
  depth: Float32Array;
  /**
   * "Replace matching" parts: the target photo's own segment at the same points
   * (e.g. its whole sky), whose splats are repainted in the source's colours there,
   * extended from the nearest ones where the source has something else in front.
   * Nothing is copied over, so a sky costs no extra splats. Null when not a replace
   * part, or when the segments didn't match (see match).
   */
  replace: ReplaceMask | null;
  /** Replace parts: share of this part's mask the target's segment covers. */
  match?: number;
}

export type SelectionState = "idle" | "loading" | "segmenting" | "ready" | "error";
export type Side = "old" | "new";

export const otherSideOf = (side: Side): Side => (side === "old" ? "new" : "old");

/**
 * "Bring in a part from the other capture" for the VR viewer: points on the source
 * photo are segmented with SAM, and inside the result the target scene shows the
 * source splats instead of its own. Works either way (old into new, new into old).
 * Points build up the current part; "next part" starts another one. Same technique
 * as the phone viewer's ✂ Old part (see viewer.ts), but editable point by point so
 * it can be driven with controllers.
 */
export class PartSelection {
  /** Prompt points of the part being edited, in source-photo pixels. */
  readonly points: PromptPoint[] = [];
  state: SelectionState = "idle";
  error = "";
  /** Union of all parts (MASK_SIZE², row 0 = top of the photo), for drawing over the photo. */
  coverage: Uint8Array | null = null;
  /** Union of the finished ("kept") parts only, drawn differently from the part being edited. */
  keptCoverage: Uint8Array | null = null;
  /** The capture the parts are shown in (the other one). */
  readonly target: Side;
  /**
   * The part being edited is sky ("Is sky" on the panel): it repaints the target
   * photo's matching segment instead of being copied in. Per part: it can only be set
   * while a part is being edited, and goes back to false for the next one.
   */
  replaceMode = false;

  private readonly parts: Part[] = [];
  private current: Part | null = null;
  private readonly mask = new PhotoMask();
  private segmenter: Promise<Segmenter> | null = null;
  private targetSegmenter: Promise<Segmenter> | null = null;
  private projection: SplatProjection | null = null;
  /** Source splats' colours on the target photo's grid, for repainting (replace parts). */
  private sourceColors: SplatColors | null = null;
  /** The normal parts' source splats, copied into the target scene (only those, not all). */
  private sourceInTarget: SplatMesh | null = null;
  private objectModifier: ReturnType<PhotoMask["modifier"]> | null = null;
  private showingTarget = false;
  private running = false;
  private pending = false;
  private readonly sourceIntrinsics: Intrinsics;
  private readonly targetIntrinsics: Intrinsics;

  /** The manifest has everything selection needs: source photo, its SAM embeddings, and both cameras. */
  static available(manifest: Manifest, source: Side) {
    const s = manifest[source];
    const t = manifest[otherSideOf(source)];
    return !!(s.image && s.sam && s.intrinsics && t.intrinsics);
  }

  /** Replace mode also segments the target photo, so it needs its embeddings too. */
  get canReplace() {
    return !!this.manifest[this.target].sam;
  }

  /** Replace parts: how much of the part being edited the target photo's segment covers (0..1). */
  get currentMatch() {
    return this.current?.match;
  }

  /** The part being edited is a replace part whose segments didn't match (it acts as a normal part). */
  get currentMismatch() {
    const c = this.current;
    return !!c && c.match !== undefined && c.replace === null;
  }

  constructor(
    private readonly manifest: Manifest,
    private readonly baseUrl: string,
    /** The capture whose photo is selected on and whose splats are brought in. */
    readonly source: Side,
    private readonly sourceMesh: SplatMesh,
    private readonly targetMesh: SplatMesh,
    /** Called whenever anything shown about the selection changes. */
    private readonly onChange: () => void,
  ) {
    this.target = otherSideOf(source);
    this.sourceIntrinsics = manifest[source].intrinsics!;
    this.targetIntrinsics = manifest[this.target].intrinsics!;
  }

  get photoUrl() {
    return new URL(this.manifest[this.source].image!, this.baseUrl).href;
  }

  get photoSize() {
    return { width: this.sourceIntrinsics.width, height: this.sourceIntrinsics.height };
  }

  /** Mask of the part being edited (its points), or null. */
  get currentCoverage() {
    return this.current?.coverage ?? null;
  }

  /** Number of finished parts (not counting the one being edited). */
  get keptCount() {
    return this.parts.length;
  }

  /** Finished parts plus the one being edited. */
  get partCount() {
    return this.parts.length + (this.current ? 1 : 0);
  }

  get active() {
    return this.partCount > 0;
  }

  /** Marks the part being edited as sky or not, and redoes it that way. Needs a part. */
  setReplaceMode(on: boolean) {
    if (!this.points.length || (on && !this.canReplace)) return;
    this.replaceMode = on;
    if (on) void this.loadTarget().catch(() => {});
    this.onChange();
    void this.resegment();
  }

  /** The target photo's segmenter, for replace mode (its embeddings, ~8 MB). */
  private loadTarget(): Promise<Segmenter> {
    if (!this.targetSegmenter) {
      const t = this.targetIntrinsics;
      const loading = import("./segmenter").then(({ Segmenter, DECODER_URL }) =>
        Segmenter.load({
          decoderUrl: DECODER_URL,
          embeddingsUrl: new URL(this.manifest[this.target].sam!, this.baseUrl).href,
          imageWidth: t.width,
          imageHeight: t.height,
          imageUrl: new URL(this.manifest[this.target].image!, this.baseUrl).href,
        }),
      );
      loading.catch(() => (this.targetSegmenter = null)); // allow a retry
      this.targetSegmenter = loading;
    }
    return this.targetSegmenter;
  }

  /** Starts loading the decoder (~21 MB) and embeddings (~8 MB); safe to call repeatedly. */
  load(): Promise<Segmenter> {
    if (!this.segmenter) {
      this.state = "loading";
      this.onChange();
      this.segmenter = import("./segmenter").then(({ Segmenter, DECODER_URL }) =>
        Segmenter.load({
          decoderUrl: DECODER_URL,
          embeddingsUrl: new URL(this.manifest[this.source].sam!, this.baseUrl).href,
          imageWidth: this.sourceIntrinsics.width,
          imageHeight: this.sourceIntrinsics.height,
          imageUrl: this.photoUrl,
        }),
      );
      this.segmenter.then(
        () => {
          if (this.state === "loading") this.state = "ready";
          this.onChange();
        },
        (e: unknown) => {
          this.segmenter = null; // allow a retry
          this.state = "error";
          this.error = e instanceof Error ? e.message : String(e);
          this.onChange();
        },
      );
    }
    return this.segmenter;
  }

  /** The brought-in splats follow the target scene's visibility. */
  setShowingTarget(showing: boolean) {
    this.showingTarget = showing;
    if (this.sourceInTarget) this.sourceInTarget.visible = showing;
  }

  addPoint(point: PromptPoint) {
    this.points.push(point);
    this.onChange();
    void this.resegment();
  }

  /** Removes the last point; with none left in the current part, removes the last finished part. */
  undo() {
    if (this.points.length) {
      this.points.pop();
      if (!this.points.length) this.replaceMode = false; // the part is gone
      this.onChange();
      void this.resegment();
    } else if (this.parts.length) {
      this.parts.pop();
      this.apply();
    }
  }

  clear() {
    this.points.length = 0;
    this.parts.length = 0;
    this.current = null;
    this.pending = false;
    this.replaceMode = false;
    this.apply();
  }

  /** "Add to scene": the current part goes into the scene, and a new, empty one starts. */
  nextPart() {
    if (!this.current || this.running) return;
    this.parts.push(this.current);
    this.current = null;
    this.points.length = 0;
    this.replaceMode = false; // per part: the next one starts as not sky
    this.apply(); // adds it to the scene and recolours it on the panel right away
  }

  /** Adds a finished part from a whole mask (the 2D photo picker). */
  addPart(coverage: Uint8Array) {
    this.nextPart();
    this.parts.push(this.toPart(coverage));
    this.apply();
  }

  // Points can arrive faster than the decoder; always finish on the latest ones.
  private async resegment() {
    if (this.running) {
      this.pending = true;
      return;
    }
    let segmenter: Segmenter;
    try {
      segmenter = await this.load();
    } catch {
      return; // state/error already set by load()
    }
    this.running = true;
    this.state = "segmenting";
    this.onChange();
    try {
      do {
        this.pending = false;
        const points = [...this.points];
        if (!points.length) {
          this.current = null;
          continue;
        }
        const part = this.toPart(await segmenter.segment(points, { growToEdges: this.replaceMode }));
        if (this.replaceMode) await this.addReplace(part, points);
        this.current = part;
      } while (this.pending);
      this.state = "ready";
    } catch (e) {
      this.state = "error";
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.running = false;
    }
    this.apply(false); // the part being edited only shows on the panel
  }

  /**
   * The source's original splats. The scenes load with LoD plus `nonLod`, so Spark
   * keeps these next to its LoD tree; the copies for parts are taken from them.
   */
  private sourceSplats() {
    const packed = this.sourceMesh.packedSplats;
    if (!packed?.numSplats || !packed.packedArray) throw new Error(`${this.source} splats not loaded`);
    return packed;
  }

  private toPart(coverage: Uint8Array): Part {
    // Built once on first use: one pass over all source splats.
    this.projection ??= SplatProjection.build(this.sourceSplats(), this.sourceIntrinsics);
    return { coverage, depth: this.projection.frontDepth(coverage), replace: null };
  }

  /**
   * Segments the target photo at the same points (e.g. its whole sky; old trees are
   * not in it, so they stay in front) and repaints that segment's own splats with the
   * source part's colours, extended smoothly from the nearest ones where the source
   * photo has something else in front (a new tree before the sky).
   * Both photos are taken from the same spot, so a pixel maps across through the two
   * cameras' intrinsics alone (the scenes share a frame, as everywhere here).
   */
  private async addReplace(part: Part, points: PromptPoint[]) {
    const segmenter = await this.loadTarget();
    const s = this.sourceIntrinsics, t = this.targetIntrinsics;
    const mapped = points.map((p) => ({
      ...p,
      x: ((p.x - s.cx) / s.fx) * t.fx + t.cx,
      y: ((p.y - s.cy) / s.fy) * t.fy + t.cy,
    }));
    const partOnTarget = resample(part.coverage, s, t);
    // Of SAM's candidates (whole / part / subpart), the one most like the selected part:
    // its own favourite was sometimes a piece of the sky, leaving a band unpainted.
    const { masks } = await segmenter.segmentAll(mapped, { growToEdges: true });
    let targetSegment = masks[0], bestIou = -1;
    for (const mask of masks) {
      const iou = overlap(partOnTarget, mask);
      if (iou > bestIou) [targetSegment, bestIou] = [mask, iou];
    }
    let inPart = 0, inBoth = 0;
    for (let i = 0; i < partOnTarget.length; i++) {
      if (partOnTarget[i] >= 128) {
        inPart++;
        if (targetSegment[i] >= 128) inBoth++;
      }
    }
    part.match = inPart ? inBoth / inPart : 0;
    if (part.match < MIN_MATCH) return; // picked something else there: stays a normal part
    // On the target's grid: the source splats live in the same frame (see above).
    this.sourceColors ??= projectColors(this.sourceSplats(), t);
    // Colours only from well inside the part: its edge texels mix in what borders it (roofs).
    const color = fillColorMap(this.sourceColors, erode(partOnTarget));
    part.replace = { fill: targetSegment, color };
  }

  /** Pushes all parts to the masks the splat shaders read, and rebuilds the copied splats. */
  private apply(sceneChanged = true) {
    // The part being edited only shows on the panel; the scene gets it on "Add to scene"
    // (nextPart), so people pick one object at a time instead of clicking around.
    this.keptCoverage = union(this.parts);
    this.coverage = union(this.current ? [...this.parts, this.current] : this.parts);
    if (!sceneChanged) {
      this.onChange();
      return;
    }
    const all = this.parts;
    // Normal parts: per texel, the most-covering part wins (with its depth).
    const added = all.filter((p) => !p.replace);
    const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
    const depth = new Float32Array(MASK_SIZE * MASK_SIZE);
    for (const part of added) {
      for (let i = 0; i < coverage.length; i++) {
        if (part.coverage[i] > coverage[i]) {
          coverage[i] = part.coverage[i];
          depth[i] = part.depth[i];
        }
      }
    }
    // Replace parts (target grid): per texel, the colour of the part that fills it most.
    let replace: ReplaceMask | undefined;
    for (const part of all) {
      const r = part.replace;
      if (!r) continue;
      replace ??= { fill: new Uint8Array(coverage.length), color: new Uint8Array(coverage.length * 4) };
      for (let i = 0; i < coverage.length; i++) {
        if (r.fill[i] > replace.fill[i] || !replace.fill[i]) {
          replace.fill[i] = Math.max(replace.fill[i], r.fill[i]);
          for (let k = 0; k < 4; k++) replace.color[i * 4 + k] = r.color[i * 4 + k];
        }
      }
    }
    if (all.length) this.enable();
    this.mask.set(coverage, depth, replace);
    this.copySplats(added.length ? coverage : null, depth);
    this.targetMesh.updateVersion();
    this.onChange();
  }

  /** First part: the target scene starts reading the masks (cut out / repainted). */
  private enable() {
    if (this.objectModifier) return;
    this.objectModifier = this.mask.modifier(this.sourceIntrinsics, "object");
    this.targetMesh.objectModifier = this.mask.modifier(this.targetIntrinsics, "rest");
    this.targetMesh.updateGenerator();
  }

  /**
   * Puts copies of just the normal parts' source splats into the target scene: a
   * small set instead of the whole capture with most of it masked out, which still
   * cost sorting and LoD work for every splat. Same shader on top for soft edges.
   */
  private copySplats(coverage: Uint8Array | null, depth: Float32Array) {
    this.sourceInTarget?.removeFromParent();
    this.sourceInTarget?.dispose();
    this.sourceInTarget = null;
    if (!coverage || !this.projection || !this.objectModifier) return;
    const indices = this.projection.select(coverage, depth);
    if (!indices.length) return;
    const source = this.sourceSplats();
    const all = source.packedArray!;
    const words = new Uint32Array(indices.length * 4); // 16 bytes per packed splat
    for (let k = 0; k < indices.length; k++) words.set(all.subarray(indices[k] * 4, indices[k] * 4 + 4), k * 4);
    const packedSplats = new PackedSplats({ packedArray: words, numSplats: indices.length, splatEncoding: source.splatEncoding });
    const mesh = new SplatMesh({ packedSplats });
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(this.sourceMesh.matrix);
    mesh.objectModifier = this.objectModifier;
    mesh.updateGenerator();
    mesh.visible = this.showingTarget;
    (this.targetMesh.parent ?? this.sourceMesh.parent ?? new THREE.Group()).add(mesh);
    this.sourceInTarget = mesh;
  }

  /** Splats copied into the other scene for this selection's normal parts. */
  get copiedSplats() {
    return this.sourceInTarget?.packedSplats?.numSplats ?? 0;
  }

  dispose() {
    this.sourceInTarget?.removeFromParent();
    this.sourceInTarget?.dispose();
  }
}

/** A MASK_SIZE² mask on one photo's grid → the other photo's grid (same viewpoint, nearest texel). */
function resample(mask: Uint8Array, from: Intrinsics, to: Intrinsics) {
  const same = (["fx", "fy", "cx", "cy", "width", "height"] as const).every((k) => from[k] === to[k]);
  if (same) return mask;
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let ty = 0; ty < MASK_SIZE; ty++) {
    const py = ((ty + 0.5) / MASK_SIZE) * to.height;
    const fy = Math.floor(((((py - to.cy) / to.fy) * from.fy + from.cy) / from.height) * MASK_SIZE);
    if (fy < 0 || fy >= MASK_SIZE) continue;
    for (let tx = 0; tx < MASK_SIZE; tx++) {
      const px = ((tx + 0.5) / MASK_SIZE) * to.width;
      const fx = Math.floor(((((px - to.cx) / to.fx) * from.fx + from.cx) / from.width) * MASK_SIZE);
      if (fx >= 0 && fx < MASK_SIZE) out[ty * MASK_SIZE + tx] = mask[fy * MASK_SIZE + fx];
    }
  }
  return out;
}

/** Intersection over union of two masks (texels at least half covered). */
function overlap(a: Uint8Array, b: Uint8Array) {
  let both = 0, either = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] >= 128, inB = b[i] >= 128;
    if (inA && inB) both++;
    if (inA || inB) either++;
  }
  return either ? both / either : 0;
}

/** Shrinks a mask by one texel (3x3 minimum). */
function erode(mask: Uint8Array) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(MASK_SIZE - 1, Math.max(0, x + dx));
          const ny = Math.min(MASK_SIZE - 1, Math.max(0, y + dy));
          m = Math.min(m, mask[ny * MASK_SIZE + nx]);
        }
      }
      out[y * MASK_SIZE + x] = m;
    }
  }
  return out;
}

function union(parts: Part[]) {
  if (!parts.length) return null;
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (const part of parts) for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], part.coverage[i]);
  return out;
}
