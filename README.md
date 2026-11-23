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

## Bringing parts of one photo into the other scene

"✂ Old part" lets you tap a region of the old photo (SAM 2.1 segmentation) and see the
old splats replace the new ones there. A side can be selected from when the manifest has its
`image`, `sam` and `intrinsics`, plus the other side's `intrinsics`; both photos must be taken
from the same spot (SHARP single-image splats). In `mine` both sides can.

Preprocessing, once per photo you want to select from:

```sh
python -m venv tools/.venv && tools/.venv/Scripts/pip install -r tools/requirements.txt
# download the SAM 2.1 ONNX export into tools/models/sam2.1-base-plus/
#   https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX (onnx/vision_encoder.onnx + _data)
python tools/sam_embed.py public/comparisons/<id>/old.jpg public/comparisons/<id>/old.sam.bin
```

Then add `"sam": "old.sam.bin"` to that side in the manifest. The matching decoder lives in
`public/models/sam2.1-base-plus/` and runs in the browser.

## VR (PC + Meta Quest Link)

`/?xr` opens the WebXR view: one scene at a time, with the photo's viewpoint placed at your
head. The PC renders and the headset displays over Link.

1. Connect the headset with Link (Meta Quest Link app on the PC; in the headset, Quick
   Settings → Link).
2. `npm run dev`
3. Open Chrome with the sandbox off, in its own profile (fast VR start, see below):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --no-sandbox --user-data-dir="$env:LOCALAPPDATA\chrome-xr-dev" "http://localhost:5173/?xr&c=mine"
```

4. Click **Enter VR**.

Only use that window for localhost: `--no-sandbox` turns off Chrome's protection. The separate
profile keeps your normal Chrome untouched; delete `%LOCALAPPDATA%\chrome-xr-dev` to clean up.
If the page says no headset was found, close that window completely and run the command again
(Chrome connects to the headset only when it starts, so this is also needed after Link
reconnects). Plain Chrome works too, but each VR start then takes ~100 s.

Add `&side=old` to start on the old capture. All splats are drawn at full detail; that needs
the PC, a standalone Quest is too slow for it.

**Frame rate:** the panel shows `fps/headset rate`, red when the PC can't keep up. Then Link
fills in frames by warping old ones, which shows as black smeared patches while you move.
Options to compare (add to the address):

- Link's refresh rate at 72 Hz (Meta Quest Link app → Devices → headset → Graphics
  preferences): same picture, 20% less work.
- `&fb=0.75`: render at 75% resolution.
- `&lod=1`: Spark's level of detail, about 875K splats drawn instead of 1.18M, but softer.
- `&front=1`: load `*.front.spz`, SHARP's two splats per pixel merged into one (half the
  splats, but clearly worse up close; made with `node scripts/spz-front-layer.mjs in.spz
  out.front.spz`, only `mine` has them).

**In VR**

- **Old / new:** both captures are loaded and switch live: **grip** while not pointing at the
  panel, or the page's Show old/new button.
- **The panel** to your left shows a photo. Point a controller at it: **trigger** adds a point
  to select, **grip** adds a point to exclude. Each point re-runs SAM and the selected part
  appears in the other scene immediately. One object per part: the part being edited is orange;
  press **✓ Keep part** before pointing at the next object, otherwise the new points are added
  to the same part and SAM tries to cover both. Kept parts turn blue. **Undo** removes the last
  point (or the last kept part); **Clear** removes all. **Old photo / New photo** pick which
  photo you select on (old parts go into the new scene and new parts into the old one). The
  page's ✂ button does the same with the mouse. SAM runs on the main thread, so expect a short
  hitch per point.
- **Added parts** hide the other scene's splats only around their own depth, so anything
  standing in front of them stays visible.
- **Moving:** **left stick** walks where you look, **right stick** left/right turns (faster
  the further you push), up/down rises and sinks, **right stick press** jumps back to the
  photo's viewpoint. SHARP splats look right only near that viewpoint, so expect stretching
  further out. The panel moves with you.
- **Left stick press** (or Exit VR on the page) leaves VR.

**Quest Link notes (Chrome 157, Windows)**

- The viewer hides the WebXR Layers API so three.js draws through a classic `XRWebGLLayer`:
  over Link, a projection-layer session starts but never gets a frame (`src/xrLayers.ts`).
- The ~100 s start without `--no-sandbox`: Meta's runtime loads its plugins inside Chrome's
  sandboxed XR process, and each one's IPC pipe times out after ~11 s. Chrome 157 ignores
  `--disable-features=XRSandbox`.
- NVIDIA drivers newer than 591.86 freeze Link (Meta's own warning in the Link app).

## Layout

- `src/splitRenderer.ts`: two scenes, each with its own SparkRenderer, drawn with a scissor split
- `src/cameraRig.ts`: limited orbit + gyro tilt
- `src/splitSlider.ts`: split handle
- `src/viewer.ts`: `createViewer()`, framework-agnostic entry point
- `src/xrViewer.ts`: the WebXR viewer; `src/xrPhotoPanel.ts` (photo panel), `src/partSelection.ts` (parts from the other capture), `src/photoMask.ts` (which splats show), `src/xrLocomotion.ts` (thumbstick movement), `src/xrLayers.ts` (Quest Link layer fix)

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/pages.yml`:
https://laufeymatth.github.io/viscomput-3/
