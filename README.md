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

## Layout

- `src/splitRenderer.ts`: two scenes, each with its own SparkRenderer, drawn with a scissor split
- `src/cameraRig.ts`: limited orbit + gyro tilt
- `src/splitSlider.ts`: split handle
- `src/viewer.ts`: `createViewer()`, framework-agnostic entry point

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/pages.yml`:
https://laufeymatth.github.io/viscomput-3/
