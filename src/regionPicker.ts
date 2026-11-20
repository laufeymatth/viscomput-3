import type { Region } from "./regions";

/** Drags shorter than this (fraction of the photo) are treated as taps and ignored. */
const MIN_SIZE = 0.01;

/**
 * Full-screen overlay over the source photo: drag rectangles over the parts that
 * may be lower resolution. Resolves with the regions, or null if cancelled.
 */
export function pickRegions(container: HTMLElement, imageUrl: string, initial: Region[]): Promise<Region[] | null> {
  const root = document.createElement("div");
  root.className = "picker region-picker";
  root.innerHTML = `
    <div class="picker-stage">
      <img class="picker-photo" alt="" draggable="false" />
      <div class="region-layer"></div>
    </div>
    <div class="picker-hint">Drag over the parts that can be lower resolution (sky, background…)</div>
    <div class="picker-bar">
      <button type="button" class="btn picker-cancel">Cancel</button>
      <button type="button" class="btn region-undo">Undo</button>
      <button type="button" class="btn region-clear">Clear</button>
      <button type="button" class="btn btn-primary picker-done">Apply</button>
    </div>`;
  container.appendChild(root);
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $<HTMLDivElement>(".picker-stage");
  const photo = $<HTMLImageElement>(".picker-photo");
  const layer = $<HTMLDivElement>(".region-layer");
  const undoBtn = $<HTMLButtonElement>(".region-undo");
  const clearBtn = $<HTMLButtonElement>(".region-clear");
  photo.src = imageUrl;

  const regions = initial.slice();
  const box = (r: Region, draft = false) => {
    const el = document.createElement("div");
    el.className = `region-box${draft ? " draft" : ""}`;
    Object.assign(el.style, {
      top: `${r.top * 100}%`,
      left: `${r.left * 100}%`,
      height: `${(r.bottom - r.top) * 100}%`,
      width: `${(r.right - r.left) * 100}%`,
    });
    return el;
  };
  const draw = (draft?: Region) => {
    layer.replaceChildren(...regions.map((r) => box(r)), ...(draft ? [box(draft, true)] : []));
    undoBtn.disabled = clearBtn.disabled = regions.length === 0;
  };
  draw();

  const toFraction = (e: PointerEvent) => {
    const rect = photo.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) };
  };
  const toRegion = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({
    top: Math.min(a.y, b.y),
    left: Math.min(a.x, b.x),
    bottom: Math.max(a.y, b.y),
    right: Math.max(a.x, b.x),
  });

  stage.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    stage.setPointerCapture(down.pointerId);
    const start = toFraction(down);
    const move = (e: PointerEvent) => draw(toRegion(start, toFraction(e)));
    const up = (e: PointerEvent) => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
      const r = toRegion(start, toFraction(e));
      if (e.type === "pointerup" && r.bottom - r.top > MIN_SIZE && r.right - r.left > MIN_SIZE) regions.push(r);
      draw();
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
  });
  undoBtn.addEventListener("click", () => {
    regions.pop();
    draw();
  });
  clearBtn.addEventListener("click", () => {
    regions.length = 0;
    draw();
  });

  return new Promise((resolve) => {
    const close = (result: Region[] | null) => {
      root.remove();
      resolve(result);
    };
    $(".picker-cancel").addEventListener("click", () => close(null));
    $(".picker-done").addEventListener("click", () => close(regions));
  });
}
