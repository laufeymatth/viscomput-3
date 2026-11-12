import { MASK_SIZE } from "./photoMask";
import type { PromptPoint, Segmenter } from "./segmenter";

const LONG_PRESS_MS = 450;
const TAP_MAX_MOVE_PX = 10;

/**
 * Full-screen picker over the source photo: tap to include a spot, long-press
 * to exclude one. Resolves with the final mask, or null if cancelled.
 */
export function pickFromPhoto(
  container: HTMLElement,
  opts: { imageUrl: string; title: string; segmenter: Promise<Segmenter> },
): Promise<Uint8Array | null> {
  const root = document.createElement("div");
  root.className = "picker loading";
  root.innerHTML = `
    <div class="picker-stage">
      <img class="picker-photo" alt="" draggable="false" />
      <canvas class="picker-mask"></canvas>
      <div class="picker-points"></div>
    </div>
    <div class="picker-hint"></div>
    <div class="picker-bar">
      <button type="button" class="btn picker-cancel">Cancel</button>
      <button type="button" class="btn picker-undo" disabled>Undo</button>
      <button type="button" class="btn btn-primary picker-done" disabled>Use part</button>
    </div>`;
  container.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $<HTMLDivElement>(".picker-stage");
  const photo = $<HTMLImageElement>(".picker-photo");
  const maskCanvas = $<HTMLCanvasElement>(".picker-mask");
  const pointsLayer = $<HTMLDivElement>(".picker-points");
  const hint = $<HTMLDivElement>(".picker-hint");
  const undoBtn = $<HTMLButtonElement>(".picker-undo");
  const doneBtn = $<HTMLButtonElement>(".picker-done");

  hint.textContent = `Loading ${opts.title}…`;
  photo.src = opts.imageUrl;

  // Mask preview: draw at mask resolution, let CSS scale it over the photo.
  maskCanvas.width = maskCanvas.height = MASK_SIZE;
  const maskCtx = maskCanvas.getContext("2d")!;
  const maskImage = maskCtx.createImageData(MASK_SIZE, MASK_SIZE);

  const points: PromptPoint[] = [];
  let mask: Uint8Array | null = null;
  let segmenter: Segmenter | null = null;
  let running = false;
  let pending = false;

  const drawMask = () => {
    const px = maskImage.data;
    for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) {
      const a = mask ? mask[i] : 0;
      px[i * 4] = 255;
      px[i * 4 + 1] = 70;
      px[i * 4 + 2] = 70;
      px[i * 4 + 3] = a * 0.55;
    }
    maskCtx.putImageData(maskImage, 0, 0);
  };

  const drawPoints = () => {
    pointsLayer.replaceChildren(
      ...points.map((p) => {
        const dot = document.createElement("div");
        dot.className = `picker-dot ${p.positive ? "pos" : "neg"}`;
        dot.style.left = `${(p.x / photo.naturalWidth) * 100}%`;
        dot.style.top = `${(p.y / photo.naturalHeight) * 100}%`;
        return dot;
      }),
    );
    undoBtn.disabled = points.length === 0;
  };

  // Clicks can arrive faster than the decoder; always finish on the latest points.
  const update = async () => {
    if (!segmenter) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    doneBtn.disabled = true;
    do {
      pending = false;
      mask = points.length ? await segmenter.segment(points) : null;
    } while (pending);
    running = false;
    drawMask();
    doneBtn.disabled = !mask;
  };

  const addPoint = (e: PointerEvent, positive: boolean) => {
    const r = photo.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * photo.naturalWidth;
    const y = ((e.clientY - r.top) / r.height) * photo.naturalHeight;
    if (x < 0 || y < 0 || x > photo.naturalWidth || y > photo.naturalHeight) return;
    points.push({ x, y, positive });
    drawPoints();
    void update();
  };

  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  stage.addEventListener("pointerdown", (down) => {
    if (!segmenter) return;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      navigator.vibrate?.(15);
      addPoint(down, false);
    }, LONG_PRESS_MS);
    const cancel = () => {
      clearTimeout(timer);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", cancel);
    };
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > TAP_MAX_MOVE_PX) cancel();
    };
    const up = () => {
      cancel();
      if (!done) addPoint(down, true);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", cancel);
  });

  undoBtn.addEventListener("click", () => {
    points.pop();
    drawPoints();
    void update();
  });

  Promise.all([opts.segmenter, photo.decode()])
    .then(([s]) => {
      segmenter = s;
      root.classList.remove("loading");
      hint.textContent = "Tap to select · long-press to exclude";
    })
    .catch((err: unknown) => {
      hint.textContent = `Couldn't load: ${err instanceof Error ? err.message : String(err)}`;
    });

  return new Promise((resolve) => {
    const close = (result: Uint8Array | null) => {
      root.remove();
      resolve(result);
    };
    $(".picker-cancel").addEventListener("click", () => close(null));
    doneBtn.addEventListener("click", () => close(mask));
  });
}
