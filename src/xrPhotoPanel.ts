import * as THREE from "three";
import { MASK_SIZE } from "./photoMask";
import type { PromptPoint } from "./segmenter";

export interface PanelButton {
  id: string;
  label: string;
  /** Drawn filled (e.g. the side being shown). */
  active?: boolean;
  disabled?: boolean;
  /** The step to take next: drawn in the accent colour so it stands out. */
  primary?: boolean;
}

export interface PanelPhoto {
  url: string;
  width: number;
  height: number;
}

export interface PanelHandlers {
  /** Trigger (positive) or grip (negative) on the photo, in photo pixels. */
  onPhoto(x: number, y: number, positive: boolean): void;
  onButton(id: string): void;
  /** Grip pressed while not pointing at the panel. */
  onSqueezeElsewhere(): void;
}

const CANVAS_W = 1280;
const HINT_H = 120;
const BUTTON_H = 110;
const PAD = 20;
/** Panel width in metres. */
const PANEL_W = 0.8;
const RAY_LENGTH = 3;
/** Mask colours: finished parts blue, the part being edited orange (same as the primary button). */
const KEPT_RGB = [60, 140, 255] as const;
const CURRENT_RGB = [255, 154, 31] as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * World-space panel beside the view (DOM isn't visible in VR): the old photo, to
 * point at with the controllers, and a row of buttons. Each controller gets a ray;
 * trigger selects, grip excludes. Everything is drawn into one canvas texture that
 * is only redrawn when its contents change.
 */
export class XrPhotoPanel {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private readonly cursor: THREE.Mesh;
  private photoRect: Rect = { x: 0, y: 0, w: CANVAS_W, h: 0 };
  private image: HTMLImageElement | null = null;
  private imageReady = false;
  private readonly maskCanvas = document.createElement("canvas");
  private buttons: PanelButton[] = [];
  private buttonRects: Rect[] = [];
  private hint = "";
  private keptCoverage: Uint8Array | null = null;
  private currentCoverage: Uint8Array | null = null;
  private points: PromptPoint[] = [];
  private hoveredButton = "";
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointers: {
    controller: THREE.XRTargetRaySpace;
    ray: THREE.Line;
    hit: THREE.Intersection | null;
    /** Set while a hand controller is behind this slot; gaze/screen sources never get a ray. */
    source: XRInputSource | null;
  }[] = [];

  constructor(
    private photo: PanelPhoto | null,
    private readonly handlers: PanelHandlers,
  ) {
    this.canvas.width = CANVAS_W;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, 1), material);
    this.mesh.renderOrder = 1002;
    this.group.add(this.mesh);

    // Where a controller points on the panel.
    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.006, 0.01, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true }),
    );
    this.cursor.renderOrder = 1003;
    this.cursor.visible = false;
    this.group.add(this.cursor);

    // Well off to the left (~65° from straight ahead) and a little below eye level,
    // like a screen beside a desk: out of the scene, a head turn away, facing the head
    // (the capture viewpoint at the origin) so it tilts up slightly towards the eyes.
    const yaw = THREE.MathUtils.degToRad(65);
    const distance = 0.95;
    this.group.position.set(-Math.sin(yaw) * distance, -0.3, -Math.cos(yaw) * distance);
    this.group.lookAt(0, 0, 0);
    this.group.visible = false;

    this.maskCanvas.width = this.maskCanvas.height = MASK_SIZE;
    this.photo = null;
    this.setPhoto(photo);
  }

  /** Shows another photo (e.g. the other capture's); the panel's height follows its aspect. */
  setPhoto(photo: PanelPhoto | null) {
    if (photo && photo.url === this.photo?.url) return;
    this.photo = photo;
    this.imageReady = false;
    this.image = null;
    const photoH = photo ? Math.round((CANVAS_W * photo.height) / photo.width) : 0;
    this.photoRect = { x: 0, y: 0, w: CANVAS_W, h: photoH };
    const canvasH = photoH + HINT_H + BUTTON_H + PAD * 2;
    if (canvasH !== this.canvas.height || !this.mesh.geometry.userData.sized) {
      this.canvas.height = canvasH;
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(PANEL_W, (PANEL_W * canvasH) / CANVAS_W);
      this.mesh.geometry.userData.sized = true;
      // A resized canvas needs a new GPU texture.
      this.texture.dispose();
    }
    if (photo) {
      const image = new Image();
      image.src = photo.url;
      this.image = image;
      image
        .decode()
        .then(() => {
          if (this.image !== image) return; // switched again meanwhile
          this.imageReady = true;
          this.redraw();
        })
        .catch(() => {});
    }
    this.redraw();
  }

  /** Adds a pointing ray to each of the renderer's XR controllers (both hands). */
  attachControllers(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }),
      );
      ray.renderOrder = 1003;
      ray.scale.z = RAY_LENGTH;
      controller.add(ray);
      scene.add(controller);
      ray.visible = false;
      const pointer = { controller, ray, hit: null as THREE.Intersection | null, source: null as XRInputSource | null };
      this.pointers.push(pointer);
      controller.addEventListener("connected", (e) => {
        const source = (e as unknown as { data: XRInputSource }).data;
        pointer.source = source.targetRayMode === "tracked-pointer" && source.handedness !== "none" ? source : null;
      });
      controller.addEventListener("disconnected", () => (pointer.source = null));
      controller.addEventListener("selectstart", () => this.press(pointer, true));
      controller.addEventListener("squeezestart", () => this.press(pointer, false));
    }
  }

  setButtons(buttons: PanelButton[]) {
    if (JSON.stringify(buttons) === JSON.stringify(this.buttons)) return;
    this.buttons = buttons;
    this.redraw();
  }

  setHint(hint: string) {
    if (hint === this.hint) return;
    this.hint = hint;
    this.redraw();
  }

  /** Kept parts are drawn blue, the part being edited orange. */
  setSelection(kept: Uint8Array | null, current: Uint8Array | null, points: PromptPoint[]) {
    this.keptCoverage = kept;
    this.currentCoverage = current;
    this.points = [...points];
    this.redraw();
  }

  /** Per frame while presenting: follow the controllers, move the cursor and highlight buttons. */
  update(presenting: boolean) {
    this.group.visible = presenting;
    let hovered = "";
    let cursorHit: THREE.Intersection | null = null;
    for (const p of this.pointers) {
      p.hit = null;
      p.ray.visible = presenting && !!p.source && p.controller.visible;
      if (!p.ray.visible) continue;
      this.raycaster.setFromXRController(p.controller);
      p.hit = this.raycaster.intersectObject(this.mesh, false)[0] ?? null;
      p.ray.scale.z = p.hit ? p.hit.distance : RAY_LENGTH;
      if (!p.hit) continue;
      cursorHit = p.hit;
      hovered ||= this.buttonAt(p.hit)?.id ?? "";
    }
    this.cursor.visible = !!cursorHit;
    if (cursorHit) {
      this.cursor.position.copy(this.group.worldToLocal(cursorHit.point.clone()));
      this.cursor.position.z = 0.002;
    }
    if (hovered !== this.hoveredButton) {
      this.hoveredButton = hovered;
      this.redraw();
    }
  }

  private press(pointer: (typeof this.pointers)[number], trigger: boolean) {
    if (!pointer.source) return;
    const hit = pointer.hit;
    if (!hit) {
      if (!trigger) this.handlers.onSqueezeElsewhere();
      return;
    }
    const button = this.buttonAt(hit);
    if (button) {
      if (trigger && !button.disabled) this.handlers.onButton(button.id);
      return;
    }
    const { x, y } = this.canvasPoint(hit);
    const r = this.photoRect;
    if (this.photo && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      this.handlers.onPhoto(((x - r.x) / r.w) * this.photo.width, ((y - r.y) / r.h) * this.photo.height, trigger);
    }
  }

  private canvasPoint(hit: THREE.Intersection) {
    const uv = hit.uv ?? new THREE.Vector2();
    return { x: uv.x * this.canvas.width, y: (1 - uv.y) * this.canvas.height };
  }

  private buttonAt(hit: THREE.Intersection) {
    const { x, y } = this.canvasPoint(hit);
    const i = this.buttonRects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    return i >= 0 ? this.buttons[i] : undefined;
  }

  private drawMask(coverage: Uint8Array | null, [r, g, b]: readonly number[]) {
    if (!coverage || !this.photo) return;
    const mctx = this.maskCanvas.getContext("2d")!;
    const img = mctx.createImageData(MASK_SIZE, MASK_SIZE);
    for (let i = 0; i < coverage.length; i++) {
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = coverage[i] * 0.6;
    }
    mctx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    const pr = this.photoRect;
    this.ctx.drawImage(this.maskCanvas, pr.x, pr.y, pr.w, pr.h);
  }

  private redraw() {
    const { ctx, canvas, photoRect: pr } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 28);
    ctx.fill();

    if (this.photo) {
      if (this.imageReady && this.image) ctx.drawImage(this.image, pr.x, pr.y, pr.w, pr.h);
      else {
        ctx.fillStyle = "#333";
        ctx.fillRect(pr.x, pr.y, pr.w, pr.h);
      }
      this.drawMask(this.keptCoverage, KEPT_RGB);
      this.drawMask(this.currentCoverage, CURRENT_RGB);
      for (const p of this.points) {
        ctx.beginPath();
        ctx.arc(pr.x + (p.x / this.photo.width) * pr.w, pr.y + (p.y / this.photo.height) * pr.h, 12, 0, Math.PI * 2);
        ctx.fillStyle = p.positive ? "#2ecc71" : "#e74c3c";
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
    }

    // Hint: first line is the instruction (bold), second line the details.
    const hintY = pr.h + PAD;
    const [line1 = "", line2 = ""] = this.hint.split("\n");
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 38px system-ui, sans-serif";
    ctx.fillText(line1, PAD, hintY + HINT_H * 0.3, canvas.width - PAD * 2);
    ctx.fillStyle = "#bbb";
    ctx.font = "32px system-ui, sans-serif";
    ctx.fillText(line2, PAD, hintY + HINT_H * 0.75, canvas.width - PAD * 2);

    const n = Math.max(1, this.buttons.length);
    const gap = 16;
    const bw = (canvas.width - PAD * 2 - gap * (n - 1)) / n;
    const by = hintY + HINT_H;
    this.buttonRects = this.buttons.map((_, i) => ({ x: PAD + i * (bw + gap), y: by, w: bw, h: BUTTON_H - PAD }));
    this.buttons.forEach((b, i) => {
      const r = this.buttonRects[i];
      const hovered = b.id === this.hoveredButton && !b.disabled;
      ctx.globalAlpha = b.disabled ? 0.35 : 1;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 18);
      const primary = b.primary && !b.disabled;
      ctx.fillStyle = b.active ? "#eee" : primary ? (hovered ? "#ffb347" : "#ff9a1f") : hovered ? "#555" : "#222";
      ctx.fill();
      ctx.lineWidth = primary ? 6 : 4;
      ctx.strokeStyle = hovered || primary ? "#fff" : "#aaa";
      ctx.stroke();
      ctx.fillStyle = b.active || primary ? "#111" : "#eee";
      ctx.font = "bold 38px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2, r.w - 16);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    });
    this.texture.needsUpdate = true;
  }
}
