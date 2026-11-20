# Splat Compare

Phone-first viewer for comparing two Gaussian splat captures of the same place (old vs new) with a draggable vertical split. Both sides share one camera, which can move slightly (drag/pinch, or device tilt) for a sense of depth.

Built with Vite, vanilla TypeScript, three.js and [Spark](https://sparkjs.dev).

## Run

```sh
npm install
npm run dev      # serves on your LAN too, for testing on a phone
```

Open `/?c=<id>` to load `public/comparisons/<id>/manifest.json` (default: `mine`).
Tilt needs HTTPS on phones.

## Adding a comparison

1. Convert each `.ply` to `.spz`: `node scripts/ply-to-spz.mjs in.ply public/comparisons/<id>/old.spz`
2. Write `public/comparisons/<id>/manifest.json` (see `src/manifest.ts` for the format).
   Both splats must already share a coordinate frame; `transform` is an optional
   4x4 column-major matrix per side.

## Bringing old parts into the new scene

"✂ Old part" lets you tap a region of the old photo (SAM 2.1 segmentation) and see the
old splats replace the new ones there. Needs `image`, `sam` and `intrinsics` on the old
side and `intrinsics` on the new side in the manifest; both photos must be taken from the
same spot (SHARP single-image splats).

Preprocessing, once per old photo:

```sh
python -m venv tools/.venv && tools/.venv/Scripts/pip install -r tools/requirements.txt
# download the SAM 2.1 ONNX export into tools/models/sam2.1-base-plus/
#   https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX (onnx/vision_encoder.onnx + _data)
python tools/sam_embed.py public/comparisons/<id>/old.jpg public/comparisons/<id>/old.sam.bin
```

The matching decoder lives in `public/models/sam2.1-base-plus/` and runs in the browser.

## VR (work in progress)

`/?xr` opens the WebXR view: one scene at a time, with the photo's viewpoint placed at your
head. WebXR only works on secure pages: https, or `http://localhost`.

- **Meta Quest Link (PC renders, headset displays):** on the PC, `npm run dev` and open
  `http://localhost:5173/?xr` in Chrome or Edge with the headset connected over Link.
- **Standalone Quest (headset renders):** `npm run dev:https` (self-signed; accept the warning on
  the headset) and open `https://<pc-ip>:5173/?xr`. Or over USB: `adb reverse tcp:5173 tcp:5173`
  and `http://localhost:5173/?xr`.

The 2D page has toggles (resolution, LoD, front layer, which side) and a stats panel; the
same stats show on a panel below your view in VR. Controllers: **A** splat budget,
**B** hide splats, **X** max splat size, **Y** refresh rate, **right stick press** tint
low-detail regions, **left stick press** exit VR. The bottom-left panel shows the session
state (starting / in VR, frames, headset visibility) and has Exit VR and Reload page buttons;
the top-right **XR log** times every WebXR call (Copy button for bug reports).

### Quest Link gotchas (Chrome 157, Windows)

- **Projection layers get no frames.** three.js uses a WebXR Layers projection layer when the
  browser has one; over Link the session starts but the browser never delivers a frame. The
  viewer therefore hides the Layers API so three.js uses a classic `XRWebGLLayer` (`&layers=1`
  opts back in). `/xr-hello.html` is a bare WebXR page that tests both layer types.
- **~100 s to start a session.** Meta's runtime loads its plugins (haptics, hand, body…)
  inside Chrome's sandboxed XR process; each one's IPC pipe is blocked and times out after ~11 s
  (see `%LOCALAPPDATA%\Oculus\Service_*.txt`, written when the Link service stops). Chrome 157
  ignores `--disable-features=XRSandbox`; only `--no-sandbox` makes it instant, which turns off
  all of Chrome's protection, so use it only in a separate profile for localhost. Otherwise
  start VR once and keep the session running.
- NVIDIA drivers newer than 591.86 freeze Link (Meta's own warning in the Link app).

**Pick low-detail regions** lets you drag rectangles over parts of the photo that may be
blurrier; those go through Spark's LoD at 50/25/100% of their splats (A), the rest stays at
full detail.

Measured on a standalone Quest 2: ~100K splats reach 72 fps, ~300K run at ~23 fps, 500K at
~10 fps. The cost is the number of splats, not resolution or splat size.

`node scripts/spz-front-layer.mjs in.spz out.front.spz` merges SHARP's two splats per pixel
into one (half the splats, nearly the same look); the region picker needs these
`*.front.spz` files.

## Layout

- `src/splitRenderer.ts`: two scenes, each with its own SparkRenderer, drawn with a scissor split
- `src/cameraRig.ts`: limited orbit + gyro tilt
- `src/splitSlider.ts`: split handle
- `src/viewer.ts`: `createViewer()`, framework-agnostic entry point

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/pages.yml`:
https://laufeymatth.github.io/viscomput-3/
