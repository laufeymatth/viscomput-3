import { CameraRig } from "./cameraRig";
import type { Manifest } from "./manifest";
import { MASK_SIZE, PhotoMask } from "./photoMask";
import { pickFromPhoto } from "./photoPicker";
import { Segmenter } from "./segmenter";
import { SplatProjection } from "./splatProjection";
import { SplitRenderer } from "./splitRenderer";
import { SplitSlider } from "./splitSlider";

const DECODER_URL = new URL(
  "models/sam2.1-base-plus/prompt_encoder_mask_decoder.onnx",
  new URL(import.meta.env.BASE_URL, location.href),
).href;

/** Hide a side's label once its half is narrower than this. */
const LABEL_HIDE_BELOW = 0.15;

export interface Viewer {
  /** Resolves once both splats are loaded and visible. */
  ready: Promise<void>;
  setSplit(value: number): void;
  dispose(): void;
}

/** Framework-agnostic: mount into any element, e.g. from a Svelte onMount later. */
export function createViewer(container: HTMLElement, manifest: Manifest, baseUrl: string): Viewer {
  const root = document.createElement("div");
  root.className = "viewer loading";
  root.innerHTML = `
    <div class="stage"></div>
    <div class="label label-old"></div>
    <div class="label label-new"></div>
    <div class="parts"></div>
    <div class="toolbar">
      <button type="button" class="btn btn-reset" aria-label="Reset view">⟲ Reset</button>
      <button type="button" class="btn btn-pick" hidden>✂ Old part</button>
      <button type="button" class="btn btn-tilt" aria-pressed="false" aria-label="Tilt to look around">◎ Tilt</button>
    </div>
    <div class="loader" role="status">
      <div class="loader-title"></div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
      <div class="loader-text">Loading…</div>
    </div>`;
  container.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $<HTMLDivElement>(".stage");
  const labelOld = $<HTMLDivElement>(".label-old");
  const labelNew = $<HTMLDivElement>(".label-new");
  const tiltBtn = $<HTMLButtonElement>(".btn-tilt");
  const loaderFill = $<HTMLDivElement>(".loader-fill");
  const loaderText = $<HTMLDivElement>(".loader-text");
  labelOld.textContent = manifest.old.label;
  labelNew.textContent = manifest.new.label;
  $(".loader-title").textContent = manifest.title;

  const splitRenderer = new SplitRenderer(stage);
  const rig = new CameraRig(splitRenderer.canvas, manifest.camera);

  const slider = new SplitSlider(stage, 0.5, (v) => {
    labelOld.classList.toggle("hidden", v < LABEL_HIDE_BELOW);
    labelNew.classList.toggle("hidden", v > 1 - LABEL_HIDE_BELOW);
  });

  $(".btn-reset").addEventListener("click", () => {
    rig.reset();
    slider.set(0.5);
  });
  if (!("DeviceOrientationEvent" in window) || !matchMedia("(pointer: coarse)").matches) {
    tiltBtn.hidden = true;
  }
  tiltBtn.addEventListener("click", async () => {
    const on = await rig.toggleGyro().catch(() => false);
    tiltBtn.setAttribute("aria-pressed", String(on));
  });

  setupReplace(root, manifest, baseUrl, splitRenderer, slider);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = stage;
    splitRenderer.setSize(w, h);
    rig.setAspect(w / h);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  let last = performance.now();
  const ready = splitRenderer
    .load(manifest, baseUrl, (f) => {
      if (f == null) {
        loaderFill.classList.add("indeterminate");
        return;
      }
      loaderFill.style.width = `${Math.round(f * 100)}%`;
      loaderText.textContent = `Loading… ${Math.round(f * 100)}%`;
    })
    .then(() => {
      root.classList.remove("loading");
      // Only start rendering once both sides exist, so a half-loaded comparison never shows.
      splitRenderer.renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        rig.update(dt);
        splitRenderer.render(rig.camera, slider.split);
      });
    })
    .catch((err: unknown) => {
      root.classList.add("error");
      loaderText.textContent = `Couldn't load: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    });

  return {
    ready,
    setSplit: (v) => slider.set(v),
    dispose() {
      resizeObserver.disconnect();
      rig.dispose();
      splitRenderer.dispose();
      root.remove();
    },
  };
}

/**
 * "Bring in old part": the user segments part of the old photo, and the new
 * scene shows the old splats there instead of its own. Session-only.
 */
function setupReplace(
  root: HTMLElement,
  manifest: Manifest,
  baseUrl: string,
  splitRenderer: SplitRenderer,
  slider: SplitSlider,
) {
  const { old: oldSide, new: newSide } = manifest;
  if (!oldSide.image || !oldSide.sam || !oldSide.intrinsics || !newSide.intrinsics) return;
  const oldIntrinsics = oldSide.intrinsics;
  const newIntrinsics = newSide.intrinsics;

  const pickBtn = root.querySelector<HTMLButtonElement>(".btn-pick")!;
  const partsEl = root.querySelector<HTMLDivElement>(".parts")!;
  pickBtn.hidden = false;

  const mask = new PhotoMask();
  const parts: { coverage: Uint8Array; depth: Float32Array }[] = [];
  let segmenter: Promise<Segmenter> | null = null;
  let projection: SplatProjection | null = null;
  let enabled = false;

  const applyParts = () => {
    // Union of all parts: per texel, the most-covering part wins (with its depth).
    const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
    const depth = new Float32Array(MASK_SIZE * MASK_SIZE);
    for (const part of parts) {
      for (let i = 0; i < coverage.length; i++) {
        if (part.coverage[i] > coverage[i]) {
          coverage[i] = part.coverage[i];
          depth[i] = part.depth[i];
        }
      }
    }
    mask.set(coverage, depth);
    splitRenderer.replaceMaskChanged(parts.length > 0);

    partsEl.replaceChildren(
      ...parts.map((part, i) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = `Old part ${i + 1} ✕`;
        chip.setAttribute("aria-label", `Remove old part ${i + 1}`);
        chip.addEventListener("click", () => {
          parts.splice(parts.indexOf(part), 1);
          applyParts();
        });
        return chip;
      }),
    );
  };

  pickBtn.addEventListener("click", async () => {
    // Loaded on first use: ~21 MB decoder + ~8 MB embeddings.
    segmenter ??= Segmenter.load({
      decoderUrl: DECODER_URL,
      embeddingsUrl: new URL(oldSide.sam!, baseUrl).href,
      imageWidth: oldIntrinsics.width,
      imageHeight: oldIntrinsics.height,
    });
    segmenter.catch(() => (segmenter = null)); // allow a retry after a failed load

    const coverage = await pickFromPhoto(root, {
      imageUrl: new URL(oldSide.image!, baseUrl).href,
      title: oldSide.label,
      segmenter,
    });
    const oldSplats = splitRenderer.oldSplats;
    if (!coverage || !oldSplats) return;

    projection ??= SplatProjection.build(oldSplats, oldIntrinsics);
    if (!enabled) {
      splitRenderer.enableReplace(mask, oldIntrinsics, newIntrinsics);
      enabled = true;
    }
    parts.push({ coverage, depth: projection.frontDepth(coverage) });
    applyParts();
    slider.set(0); // show the new scene with the old part in it
  });
}
