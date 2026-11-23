import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { Intrinsics, Manifest } from "./manifest";
import { MASK_SIZE, PhotoMask } from "./photoMask";
import type { PromptPoint, Segmenter } from "./segmenter";
import { SplatProjection } from "./splatProjection";

interface Part {
  coverage: Uint8Array;
  depth: Float32Array;
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

  private readonly parts: Part[] = [];
  private current: Part | null = null;
  private readonly mask = new PhotoMask();
  private segmenter: Promise<Segmenter> | null = null;
  private projection: SplatProjection | null = null;
  private sourceInTarget: SplatMesh | null = null;
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
    if (this.sourceInTarget) this.sourceInTarget.visible = showing && this.active;
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
    this.apply();
  }

  /** Keeps the current part and starts a new, empty one. */
  nextPart() {
    if (!this.current || this.running) return;
    this.parts.push(this.current);
    this.current = null;
    this.points.length = 0;
    this.apply(); // recolours the kept part right away
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
        this.current = points.length ? this.toPart(await segmenter.segment(points)) : null;
      } while (this.pending);
      this.state = "ready";
    } catch (e) {
      this.state = "error";
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.running = false;
    }
    this.apply();
  }

  private toPart(coverage: Uint8Array): Part {
    // Built once on first use: one pass over all source splats. With LoD, Spark keeps
    // only the LoD tree (packedSplats is emptied); its inner nodes are averages of
    // their children, so they never sit in front of the real surface.
    if (!this.projection) {
      const packed = this.sourceMesh.packedSplats!;
      const splats = packed.numSplats ? packed : packed.lodSplats;
      if (!splats?.numSplats) throw new Error(`${this.source} splats not loaded`);
      this.projection = SplatProjection.build(splats, this.sourceIntrinsics);
    }
    return { coverage, depth: this.projection.frontDepth(coverage) };
  }

  /** Pushes the union of all parts to the mask the splat shaders read. */
  private apply() {
    const all = this.current ? [...this.parts, this.current] : this.parts;
    this.keptCoverage = union(this.parts);
    // Per texel, the most-covering part wins (with its depth).
    const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
    const depth = new Float32Array(MASK_SIZE * MASK_SIZE);
    for (const part of all) {
      for (let i = 0; i < coverage.length; i++) {
        if (part.coverage[i] > coverage[i]) {
          coverage[i] = part.coverage[i];
          depth[i] = part.depth[i];
        }
      }
    }
    this.coverage = all.length ? coverage : null;
    if (all.length) this.enable();
    this.mask.set(coverage, depth);
    if (this.sourceInTarget) {
      this.sourceInTarget.visible = this.showingTarget && all.length > 0;
      this.sourceInTarget.updateVersion();
      this.targetMesh.updateVersion();
    }
    this.onChange();
  }

  /** First part: add the masked source splats next to the target ones, and cut the target ones there. */
  private enable() {
    if (this.sourceInTarget) return;
    // Shares the loaded source splat data (and its LoD tree); nothing is loaded twice.
    const mesh = new SplatMesh({ packedSplats: this.sourceMesh.packedSplats });
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(this.sourceMesh.matrix);
    mesh.objectModifier = this.mask.modifier(this.sourceIntrinsics, "object");
    mesh.updateGenerator();
    (this.targetMesh.parent ?? this.sourceMesh.parent ?? new THREE.Group()).add(mesh);
    this.sourceInTarget = mesh;

    this.targetMesh.objectModifier = this.mask.modifier(this.targetIntrinsics, "rest");
    this.targetMesh.updateGenerator();
  }

  dispose() {
    this.sourceInTarget?.removeFromParent();
    this.sourceInTarget?.dispose();
  }
}

function union(parts: Part[]) {
  if (!parts.length) return null;
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (const part of parts) for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], part.coverage[i]);
  return out;
}
