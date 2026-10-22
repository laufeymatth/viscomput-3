import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import type { SplatSide } from "./manifest";

const MAX_PIXEL_RATIO = 1.5;

/**
 * Renders two splat scenes side by side with a vertical split, sharing one camera.
 * Each scene has its own SparkRenderer, so each sorts only its own splats.
 */
export class SplitRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly oldScene = new THREE.Scene();
  private readonly newScene = new THREE.Scene();
  private readonly size = new THREE.Vector2();

  constructor(container: HTMLElement) {
    // antialias off: MSAA doesn't help splats and costs a lot on mobile.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setClearColor(0x111111);
    // With the scissor test on, autoClear only clears the current half.
    this.renderer.setScissorTest(true);
    container.appendChild(this.renderer.domElement);

    this.oldScene.add(new SparkRenderer({ renderer: this.renderer }));
    this.newScene.add(new SparkRenderer({ renderer: this.renderer }));
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Loads both sides; onProgress reports combined bytes as 0..1 (or null if unknown). */
  async load(sides: { old: SplatSide; new: SplatSide }, baseUrl: string, onProgress: (fraction: number | null) => void) {
    const loaded = { old: 0, new: 0 };
    const total = { old: 0, new: 0 };
    const report = () => {
      const t = total.old + total.new;
      onProgress(total.old && total.new ? (loaded.old + loaded.new) / t : null);
    };

    const loadSide = (key: "old" | "new", scene: THREE.Scene) => {
      const side = sides[key];
      const mesh = new SplatMesh({
        url: new URL(side.url, baseUrl).href,
        onProgress: (e) => {
          loaded[key] = e.loaded;
          total[key] = e.lengthComputable ? e.total : 0;
          report();
        },
      });
      if (side.transform) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(side.transform);
      }
      scene.add(mesh);
      return mesh.initialized;
    };

    await Promise.all([loadSide("old", this.oldScene), loadSide("new", this.newScene)]);
  }

  setSize(width: number, height: number) {
    this.renderer.setSize(width, height);
  }

  /** split is the fraction of the width (from the left) that shows the old scene. */
  render(camera: THREE.Camera, split: number) {
    this.renderer.getSize(this.size);
    const { x: w, y: h } = this.size;
    const splitX = Math.round(THREE.MathUtils.clamp(split, 0, 1) * w);

    // Skipping an empty half also skips its sort work.
    if (splitX > 0) {
      this.renderer.setScissor(0, 0, splitX, h);
      this.renderer.render(this.oldScene, camera);
    }
    if (splitX < w) {
      this.renderer.setScissor(splitX, 0, w - splitX, h);
      this.renderer.render(this.newScene, camera);
    }
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    for (const scene of [this.oldScene, this.newScene]) {
      scene.traverse((obj) => {
        if (obj instanceof SplatMesh || obj instanceof SparkRenderer) obj.dispose();
      });
    }
    this.renderer.dispose();
    this.canvas.remove();
  }
}
