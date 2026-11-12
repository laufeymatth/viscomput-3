"""Precompute SAM 2.1 image embeddings for the browser-side mask decoder.

Usage: python tools/sam_embed.py <image> <out.bin> [--model tools/models/sam2.1-base-plus]

Writes the three encoder outputs as raw little-endian float16, concatenated in
order (image_embeddings.0, .1, .2). Shapes are fixed for SAM 2.1 at 1024x1024:
  0: 1x32x256x256   1: 1x64x128x128   2: 1x256x64x64
"""

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
SHAPES = [(1, 32, 256, 256), (1, 64, 128, 128), (1, 256, 64, 64)]


def preprocess(image: Image.Image) -> np.ndarray:
    # SAM 2.1 resizes straight to 1024x1024 (no aspect-preserving pad).
    resized = image.convert("RGB").resize((SIZE, SIZE), Image.Resampling.BILINEAR)
    x = (np.asarray(resized, dtype=np.float32) / 255.0 - MEAN) / STD
    return x.transpose(2, 0, 1)[None]


def embed(image_path: Path, model_dir: Path) -> list[np.ndarray]:
    session = ort.InferenceSession(str(model_dir / "vision_encoder.onnx"), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {"pixel_values": preprocess(Image.open(image_path))})
    for out, shape in zip(outputs, SHAPES):
        assert out.shape == shape, f"unexpected embedding shape {out.shape}, expected {shape}"
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--model", type=Path, default=Path(__file__).parent / "models" / "sam2.1-base-plus")
    args = parser.parse_args()

    outputs = embed(args.image, args.model)
    with open(args.out, "wb") as f:
        for out in outputs:
            f.write(out.astype("<f2").tobytes())
    print(f"{args.image} -> {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
