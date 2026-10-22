import { CameraRig } from "./cameraRig";
import type { Manifest } from "./manifest";
import { SplitRenderer } from "./splitRenderer";
import { SplitSlider } from "./splitSlider";

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
    <div class="toolbar">
      <button type="button" class="btn btn-reset" aria-label="Reset view">⟲ Reset</button>
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
