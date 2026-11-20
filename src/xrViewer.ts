import * as THREE from "three";
import { PackedSplats, SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import { CameraRig } from "./cameraRig";
import type { Manifest } from "./manifest";
import { pickRegions } from "./regionPicker";
import { formatRegions, parseRegions, splitByRegions, type Region } from "./regions";

/**
 * Head offset from the capture origin (metres) where the comfort fade starts / is
 * fully black. SHARP splats are only valid near the photo's viewpoint.
 */
const FADE_START_M = 0.25;
const FADE_END_M = 0.5;

/** Spark's own default LoD budget on Oculus browsers. */
const OCULUS_LOD_SPLATS = 500_000;

/**
 * Two independent axes so their costs can be told apart on the headset.
 * A (right) cycles splat COUNT: LoD budget, and the smallest splat LoD will pick.
 */
const COUNT_LEVELS = [
  { name: "500K", lodScale: 1, lodRenderScale: 1 },
  { name: "300K", lodScale: 0.6, lodRenderScale: 2 },
  { name: "175K", lodScale: 0.35, lodRenderScale: 3 },
  { name: "100K", lodScale: 0.2, lodRenderScale: 4 },
] as const;
/**
 * X (left) cycles splat SIZE: SHARP splats sit close to the camera and overlap a
 * lot, so capping on-screen radius and the Gaussian cut-off cuts overdraw.
 */
const SIZE_LEVELS = [
  { name: "512px", maxPixelRadius: 512, maxStdDev: Math.sqrt(8) },
  { name: "128px", maxPixelRadius: 128, maxStdDev: Math.sqrt(6) },
  { name: "64px", maxPixelRadius: 64, maxStdDev: Math.sqrt(5) },
  { name: "32px", maxPixelRadius: 32, maxStdDev: 2 },
] as const;
// Measured on Quest 2 (500K, fb 1): throttling Spark's per-frame rebuild/sort
// (manual update every 100 ms–1 s) was no faster than its default, so the cost is
// the per-splat draw, not the rebuild. Splat size caps made no difference either.
// covSplats (cheaper vertex math) needs 32-byte extSplats and throws "No next
// accumulator" in Spark 2.4 with LoD, so it isn't offered.

/**
 * With low-detail regions picked, A cycles how much of those regions' own splats
 * Spark's LoD may draw; the rest is always drawn at full detail. A fraction, not a
 * fixed count: a fixed 50K made a large region (e.g. half the photo, ~295K splats)
 * so coarse it turned see-through, while a small one barely changed. Measured on
 * that half: 50% and 25% stay solid, ~17% is already see-through, so no lower step.
 */
const LOW_FRACTIONS = [0.5, 0.25, 1];

/** Y (left) cycles the display refresh rate among these, if the headset supports them. */
const PREFERRED_RATES = [72, 60, 90];

export interface XrOptions {
  side: "old" | "new";
  /** Build a LoD tree on load and render at most ~lodSplatCount × lodScale splats. */
  lod: boolean;
  lodScale: number;
  /** WebXR framebuffer scale. Spark defaults to 0.5; on Quest 2 full res cost ~nothing (count-bound, not fill-bound). */
  framebufferScale: number;
  /** Multiplies the splat's size; 1 = SHARP's (roughly metric) scale. */
  worldScale: number;
  /** Spark's slower, higher-quality LoD build instead of "Tiny LoD". */
  lodQuality: boolean;
  /** Load `<name>.front.spz` (nearest of SHARP's two splats per pixel; scripts/spz-front-layer.mjs). */
  frontLayer: boolean;
  /**
   * Parts of the photo the user marked as allowed to be lower resolution. When
   * set, `<name>.front.spz` is split: these regions go through Spark's LoD at a
   * reduced budget (LOW_FRACTIONS), everything else is drawn at full detail.
   */
  lowRegions: Region[];
  /** Start with the low-detail splats tinted red (toggle in VR: right thumbstick press). */
  tintLow: boolean;
  /** Starting LoD fraction for the low-detail regions (one of LOW_FRACTIONS); A cycles from there. */
  lowFraction: number;
}

/** Multiplied into low-detail splat colours when tinting. */
const LOW_TINT = [1, 0.35, 0.35] as const;

/** `?xr&side=old&lod=0&lodScale=1.5&fb=0.75&worldScale=1&lodq=1&front=1&low=t,l,b,r_t,l,b,r` — all optional. */
export function parseXrOptions(params: URLSearchParams): XrOptions {
  const num = (key: string, fallback: number) => {
    const v = Number(params.get(key));
    return params.has(key) && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    side: params.get("side") === "old" ? "old" : "new",
    lod: params.get("lod") !== "0",
    lodScale: num("lodScale", 1),
    framebufferScale: num("fb", 1),
    worldScale: num("worldScale", 1),
    lodQuality: params.get("lodq") === "1",
    frontLayer: params.get("front") === "1",
    lowRegions: parseRegions(params.get("low")),
    tintLow: params.get("tint") === "1",
    lowFraction: Number(params.get("lowfrac")) || LOW_FRACTIONS[0],
  };
}

/**
 * VR spike: one splat in a WebXR session, with the photo's viewpoint placed at
 * the user's head (the "local" reference space origin is the head pose at session
 * start). Outside VR it falls back to the normal limited-orbit camera.
 */
export function createXrViewer(container: HTMLElement, manifest: Manifest, baseUrl: string, opts: XrOptions) {
  const root = document.createElement("div");
  root.className = "viewer loading";
  root.innerHTML = `
    <div class="stage"></div>
    <div class="label label-old"></div>
    <div class="toolbar xr-options"></div>
    <pre class="perf" aria-live="off"></pre>
    <div class="loader" role="status">
      <div class="loader-title"></div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
      <div class="loader-text">Loading…</div>
    </div>`;
  container.appendChild(root);
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $<HTMLDivElement>(".stage");
  const status = $<HTMLDivElement>(".label-old");
  const loaderFill = $<HTMLDivElement>(".loader-fill");
  const loaderText = $<HTMLDivElement>(".loader-text");
  $(".loader-title").textContent = manifest.title;
  const side = manifest[opts.side];
  status.textContent = `${side.label} · checking VR…`;

  // Framebuffer scale, LoD and side can't change inside a session: page links that reload with new params.
  const link = (label: string, key: string, value: string, active: boolean) => {
    const params = new URLSearchParams(location.search);
    params.set(key, value);
    const a = document.createElement("a");
    a.className = `btn${active ? " btn-primary" : ""}`;
    a.href = `?${params}`;
    a.textContent = label;
    return a;
  };
  // White = on. Tap to flip and reload.
  const toggle = (label: string, key: string, on: boolean) => link(label, key, on ? "0" : "1", on);
  $(".xr-options").append(
    ...[0.5, 1].map((fb) => link(`fb ${fb}`, "fb", String(fb), fb === opts.framebufferScale)),
    toggle("LoD", "lod", opts.lod),
    toggle("LoD quality", "lodq", opts.lodQuality),
    toggle("Front layer only", "front", opts.frontLayer),
    link(`Show ${opts.side === "new" ? "old" : "new"}`, "side", opts.side === "new" ? "old" : "new", false),
  );

  // Low-detail region picker: draw on the source photo, then reload with ?low=…
  if (side.image) {
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = `btn${opts.lowRegions.length ? " btn-primary" : ""}`;
    pickBtn.textContent = opts.lowRegions.length
      ? `Low-detail regions: ${opts.lowRegions.length}`
      : "Pick low-detail regions";
    pickBtn.addEventListener("click", async () => {
      const regions = await pickRegions(root, new URL(side.image!, baseUrl).href, opts.lowRegions);
      if (!regions) return;
      const params = new URLSearchParams(location.search);
      if (regions.length) params.set("low", formatRegions(regions));
      else params.delete("low");
      location.search = params.toString();
    });
    $(".xr-options").append(pickBtn);
    if (opts.lowRegions.length) $(".xr-options").append(toggle("Tint low-detail", "tint", opts.tintLow));
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const spark = new SparkRenderer({ renderer, lodSplatScale: opts.lodScale });
  scene.add(spark);
  const regionMode = opts.lowRegions.length > 0;
  /** Splats in the low-detail regions before LoD (known once loaded). */
  let lowSourceSplats = 0;
  let countIndex = regionMode ? Math.max(0, LOW_FRACTIONS.findIndex((f) => f === opts.lowFraction)) : 0;
  const lowFraction = () => LOW_FRACTIONS[countIndex % LOW_FRACTIONS.length];
  let sizeIndex = 0;
  const applyLevels = () => {
    const c = COUNT_LEVELS[countIndex];
    const s = SIZE_LEVELS[sizeIndex];
    if (regionMode) {
      // Only the low-detail mesh has LoD, so the budget applies to it alone.
      spark.lodSplatCount = Math.max(1000, Math.round(lowFraction() * lowSourceSplats));
      spark.lodSplatScale = 1;
      spark.lodRenderScale = 1;
    } else {
      spark.lodSplatScale = c.lodScale * opts.lodScale;
      spark.lodRenderScale = c.lodRenderScale;
    }
    spark.maxStdDev = s.maxStdDev;
    spark.maxPixelRadius = s.maxPixelRadius;
  };
  applyLevels();

  type RateSession = XRSession & {
    supportedFrameRates?: Float32Array;
    updateTargetFrameRate?: (hz: number) => Promise<void>;
  };
  let rateIndex = 0;
  const setRate = async () => {
    const session = renderer.xr.getSession() as RateSession | null;
    if (!session) return;
    const supported = Array.from(session.supportedFrameRates ?? []);
    const rates = PREFERRED_RATES.filter((r) => supported.some((s) => Math.abs(s - r) < 0.5));
    if (rates.length) await session.updateTargetFrameRate?.(rates[rateIndex % rates.length]).catch(() => {});
    hud.targetHz = session.frameRate ?? 0;
    updateInfo();
  };

  // The splat's own frame puts the photo's camera at the origin looking down -Z.
  const world = new THREE.Group();
  world.scale.setScalar(opts.worldScale);
  scene.add(world);

  // All splat meshes share the splat file's frame (manifest transform).
  const splatGroup = new THREE.Group();
  if (side.transform) {
    splatGroup.matrixAutoUpdate = false;
    splatGroup.matrix.fromArray(side.transform);
  }
  world.add(splatGroup);

  const onProgress = (e: ProgressEvent) => {
    if (!e.lengthComputable) return loaderFill.classList.add("indeterminate");
    const f = e.loaded / e.total;
    loaderFill.style.width = `${Math.round(f * 100)}%`;
    loaderText.textContent = `Loading… ${Math.round(f * 100)}%`;
  };
  // Tint the low-detail splats so the regions can be checked in the scene itself.
  let lowMesh: SplatMesh | null = null;
  let tint = opts.tintLow;
  const applyTint = () => {
    const [r, g, b] = tint ? LOW_TINT : [1, 1, 1];
    lowMesh?.recolor.setRGB(r, g, b);
  };
  /** Splats always drawn in full (region mode), for the stats panel. */
  let fullDetailSplats = 0;
  const meshes: SplatMesh[] = [];
  const load = async () => {
    if (!regionMode) {
      const url = opts.frontLayer ? side.url.replace(/\.spz$/, ".front.spz") : side.url;
      const mesh = new SplatMesh({
        url: new URL(url, baseUrl).href,
        lod: opts.lod ? (opts.lodQuality ? "quality" : true) : undefined,
        onProgress,
      });
      meshes.push(mesh);
      splatGroup.add(mesh);
      await mesh.initialized;
      return;
    }
    // Region mode needs one splat per photo pixel, so always the merged front layer.
    const all = new PackedSplats({ url: new URL(side.url.replace(/\.spz$/, ".front.spz"), baseUrl).href, onProgress });
    await all.initialized;
    loaderText.textContent = "Splitting regions…";
    const { inside, outside } = splitByRegions(all, opts.lowRegions);
    all.dispose();
    fullDetailSplats = outside.numSplats;
    lowSourceSplats = inside.numSplats;
    applyLevels();
    loaderText.textContent = "Building low-detail version…";
    await inside.createLodSplats({ quality: opts.lodQuality });
    const detail = new SplatMesh({ packedSplats: outside, enableLod: false });
    const low = new SplatMesh({ packedSplats: inside });
    lowMesh = low;
    applyTint();
    meshes.push(detail, low);
    splatGroup.add(detail, low);
    await Promise.all([detail.initialized, low.initialized]);
  };

  const fade = makeFade();
  scene.add(fade.mesh);
  const hud = new Hud();
  scene.add(hud.mesh);

  // Non-XR preview camera, and a separate parentless camera for XR so the head
  // pose is relative to the scene origin (= the capture viewpoint).
  const rig = new CameraRig(renderer.domElement, manifest.camera);
  const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 1000);

  const xr = new SparkXr({
    renderer,
    mode: "vr",
    referenceSpaceType: "local",
    frameBufferScaleFactor: opts.framebufferScale,
    onReady: (supported) => {
      // Browsers only expose WebXR on secure pages: https, or http://localhost (e.g. over USB with adb reverse).
      const reason = !window.isSecureContext
        ? `VR blocked: plain http on ${location.hostname} isn't a secure page. Open http://localhost:${location.port}/?xr over USB (adb reverse tcp:${location.port} tcp:${location.port}), or allow this address under chrome://flags → "Insecure origins treated as secure"`
        : "VR not available in this browser (needs a headset)";
      status.textContent = `${side.label} · ${supported ? "VR ready" : reason}`;
    },
    // The Quest browser may run at 90 Hz; start at 72 Hz (13.9 ms per frame instead of 11.1 ms).
    onEnterXr: () => {
      rateIndex = 0;
      return setRate();
    },
  });

  // A (right): splat count · B (right): hide splat · X (left): splat size · Y (left): refresh rate.
  // Right thumbstick press: tint low-detail regions.
  // xr-standard gamepad mapping: buttons[3] = thumbstick press, buttons[4] = A/X, buttons[5] = B/Y.
  const actions = {
    "right:4": () => (countIndex = (countIndex + 1) % COUNT_LEVELS.length),
    "right:5": () => (splatGroup.visible = !splatGroup.visible),
    "right:3": () => {
      tint = !tint;
      applyTint();
    },
    "left:4": () => (sizeIndex = (sizeIndex + 1) % SIZE_LEVELS.length),
    "left:5": () => {
      rateIndex++;
      void setRate();
    },
  } as Record<string, () => unknown>;
  const pressed = new Set<string>();
  const pollButtons = () => {
    const session = renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      for (const i of [3, 4, 5]) {
        const key = `${source.handedness}:${i}`;
        const action = actions[key];
        if (!action) continue;
        const down = source.gamepad.buttons[i]?.pressed ?? false;
        if (down && !pressed.has(key)) {
          action();
          applyLevels();
          updateInfo();
        }
        if (down) pressed.add(key);
        else pressed.delete(key);
      }
    }
  };
  const updateInfo = () => {
    const c = COUNT_LEVELS[countIndex];
    const s = SIZE_LEVELS[sizeIndex];
    const count = regionMode
      ? `low ${Math.round(lowFraction() * 100)}% (≤${formatCount(lowFraction() * lowSourceSplats)})`
      : opts.lod
        ? `${Math.round((OCULUS_LOD_SPLATS * c.lodScale * opts.lodScale) / 1000)}K`
        : "all (no LoD)";
    const flags = [
      `fb ${opts.framebufferScale}`,
      opts.frontLayer && "front layer",
      opts.lodQuality && "LoD quality",
      regionMode && `${opts.lowRegions.length} low-detail region${opts.lowRegions.length > 1 ? "s" : ""}${tint ? " (tinted)" : ""}`,
    ].filter(Boolean).join(", ");
    hud.info = !splatGroup.visible
      ? `${side.label} HIDDEN (B) · ${flags}`
      : `A ${count} · X ${s.name} · Y ${hud.targetHz ? `${Math.round(hud.targetHz)} Hz` : "rate"} · ${flags}`;
  };

  const resize = () => {
    if (renderer.xr.isPresenting) return;
    const { clientWidth: w, clientHeight: h } = stage;
    renderer.setSize(w, h);
    rig.setAspect(w / h);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  const perfEl = $<HTMLPreElement>(".perf");
  const perf = new PerfMeter();
  const loadStart = performance.now();
  let loadSeconds = 0;
  const resolution = () => {
    const layer = renderer.xr.getSession()?.renderState.baseLayer;
    if (renderer.xr.isPresenting && layer) {
      // Both eyes side by side in one framebuffer.
      return `${layer.framebufferWidth / 2}×${layer.framebufferHeight} per eye`;
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return `${size.x}×${size.y}`;
  };
  const showPerf = (s: PerfSample) => {
    const target = hud.targetHz ? `/${Math.round(hud.targetHz)}` : "";
    const lines = [
      `${s.fps.toFixed(0)}${target} fps · ${s.avgMs.toFixed(1)} ms avg · ${s.worstMs.toFixed(0)} ms worst`,
      regionMode
        ? `drawn ${formatCount(spark.activeSplats)} splats (${formatCount(fullDetailSplats)} full + ${formatCount(Math.max(0, spark.activeSplats - fullDetailSplats))} low) · CPU ${s.renderCpuMs.toFixed(1)} ms`
        : `drawn ${formatCount(spark.activeSplats)} splats · draw call CPU ${s.renderCpuMs.toFixed(1)} ms`,
      `${resolution()} · head ${(s.headOffset * 100).toFixed(0)} cm`,
    ];
    hud.show([...lines, hud.info], !hud.targetHz || s.fps >= hud.targetHz * 0.95);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    perfEl.textContent = [
      ...lines,
      `load ${loadSeconds.toFixed(1)} s${heap ? ` · JS heap ${Math.round(heap.usedJSHeapSize / 1e6)} MB` : ""}`,
      hud.info,
    ].join("\n");
  };

  const headPos = new THREE.Vector3();
  let last = performance.now();
  const ready = load()
    .then(() => {
      loadSeconds = (performance.now() - loadStart) / 1000;
      root.classList.remove("loading");
      updateInfo();
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const presenting = renderer.xr.isPresenting;
        let offset = 0;
        if (presenting) {
          pollButtons();
          // Head pose from the previous frame; one frame of lag is fine for a fade.
          headPos.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
          offset = headPos.length();
        } else {
          rig.update(dt);
          headPos.setFromMatrixPosition(rig.camera.matrixWorld);
        }
        fade.update(headPos, presenting ? offset : 0);
        hud.mesh.visible = presenting;
        // CPU time of the draw call only: Spark's per-frame work plus WebGL command submission.
        const t0 = performance.now();
        renderer.render(scene, presenting ? xrCamera : rig.camera);
        const sample = perf.frame(now, performance.now() - t0, offset);
        if (sample) showPerf(sample);
      });
    })
    .catch((err: unknown) => {
      root.classList.add("error");
      loaderText.textContent = `Couldn't load: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    });

  return {
    ready,
    xr,
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      rig.dispose();
      for (const m of meshes) m.dispose();
      renderer.dispose();
      root.remove();
    },
  };
}

/** Black inside-out sphere around the head that fades in as the user leaves the valid viewpoint. */
function makeFade() {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), material);
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(head: THREE.Vector3, offset: number) {
      mesh.position.copy(head);
      material.opacity = THREE.MathUtils.smoothstep(offset, FADE_START_M, FADE_END_M);
      mesh.visible = material.opacity > 0.001;
    },
  };
}

function formatCount(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`;
}

interface PerfSample {
  fps: number;
  avgMs: number;
  worstMs: number;
  /** Average CPU time spent inside renderer.render(). */
  renderCpuMs: number;
  headOffset: number;
}

/** Aggregates per-frame timings into one sample per second. */
class PerfMeter {
  private frames = 0;
  private windowStart = 0;
  private lastFrame = 0;
  private worstMs = 0;
  private cpuSum = 0;

  frame(now: number, renderCpuMs: number, headOffset: number): PerfSample | null {
    if (this.lastFrame) this.worstMs = Math.max(this.worstMs, now - this.lastFrame);
    this.lastFrame = now;
    this.frames++;
    this.cpuSum += renderCpuMs;
    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return null;

    const sample = {
      fps: (this.frames * 1000) / elapsed,
      avgMs: elapsed / this.frames,
      worstMs: this.worstMs,
      renderCpuMs: this.cpuSum / this.frames,
      headOffset,
    };
    this.frames = 0;
    this.worstMs = 0;
    this.cpuSum = 0;
    this.windowStart = now;
    return sample;
  }
}

/** Small world-space text panel below the forward view (DOM isn't visible in VR). */
class Hud {
  readonly mesh: THREE.Mesh;
  info = "";
  targetHz = 0;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 288;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.16875), material);
    // ~1.2 m ahead, ~25° below eye level, tilted to face the head.
    this.mesh.position.set(0, -0.55, -1.2);
    this.mesh.rotation.x = -0.4;
    this.mesh.renderOrder = 1001;
    this.mesh.visible = false;
  }

  /** First line large (green when on target, red when not), the rest small. */
  show(lines: string[], ok: boolean) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 32);
    ctx.fill();
    ctx.fillStyle = ok ? "#9f9" : "#f99";
    ctx.font = "bold 52px system-ui, sans-serif";
    ctx.fillText(lines[0], 32, 70);
    ctx.fillStyle = "#ddd";
    ctx.font = "34px system-ui, sans-serif";
    lines.slice(1).forEach((line, i) => ctx.fillText(line, 32, 128 + i * 48));
    this.texture.needsUpdate = true;
  }
}
