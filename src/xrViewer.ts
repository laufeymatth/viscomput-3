import * as THREE from "three";
import { PackedSplats, SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import { CameraRig } from "./cameraRig";
import { XrDebug } from "./xrDebug";
import type { Manifest, SplatSide } from "./manifest";
import { PartSelection, type Side } from "./partSelection";
import { pickFromPhoto } from "./photoPicker";
import { pickRegions } from "./regionPicker";
import { XrPhotoPanel, type PanelButton } from "./xrPhotoPanel";
import { XrLocomotion } from "./xrLocomotion";
import { formatRegions, parseRegions, splitByRegions, type Region } from "./regions";

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
  /** Side shown first; both are loaded and can be switched live (except with low-detail regions). */
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
  /**
   * Make three.js draw through a classic XRWebGLLayer instead of a WebXR Layers
   * projection layer. On by default: Chrome 157 over Quest Link never delivers a
   * single frame to a projection-layer session (measured), while XRWebGLLayer
   * streams at full rate. `layers=1` opts back into projection layers.
   */
  classicLayer: boolean;
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
    classicLayer: params.get("layers") !== "1",
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
  /** Side the page opened with; low-detail regions (region mode) only ever load this one. */
  const side = manifest[opts.side];
  let current: "old" | "new" = opts.side;
  let vrStatus = "checking VR…";
  const showStatus = () => (status.textContent = `${manifest[current].label} · ${vrStatus}`);
  showStatus();

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
  // Patch the WebXR entry points before anything (Spark, three.js) touches them.
  const debug = new XrDebug(root, { forceClassicLayer: opts.classicLayer });

  $(".xr-options").append(
    ...[0.5, 1].map((fb) => link(`fb ${fb}`, "fb", String(fb), fb === opts.framebufferScale)),
    link("Classic XR layer", "layers", opts.classicLayer ? "1" : "0", opts.classicLayer),
    toggle("LoD", "lod", opts.lod),
    toggle("LoD quality", "lodq", opts.lodQuality),
    toggle("Front layer only", "front", opts.frontLayer),
  );
  // Region mode loads one side only, so switching reloads; otherwise it's live (sideBtn).
  const regionMode = opts.lowRegions.length > 0;
  const sideBtn = document.createElement("button");
  sideBtn.type = "button";
  sideBtn.className = "btn";
  const otherSide = () => (current === "new" ? "old" : "new");
  if (regionMode) {
    $(".xr-options").append(link(`Show ${otherSide()}`, "side", otherSide(), false));
  } else {
    sideBtn.addEventListener("click", () => showSide(otherSide()));
    $(".xr-options").append(sideBtn);
  }
  const partBtn = document.createElement("button");
  partBtn.type = "button";
  partBtn.className = "btn";
  partBtn.textContent = "✂ Old part";
  partBtn.hidden = true;
  $(".xr-options").append(partBtn);

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
  // Inside the locomotion root, which the thumbsticks move (the panel and HUD stay put).
  const world = new THREE.Group();
  world.scale.setScalar(opts.worldScale);
  const loco = new XrLocomotion();
  loco.root.add(world);
  scene.add(loco.root);

  // Every splat mesh; B hides them all. Each mesh carries its side's manifest transform.
  const splatGroup = new THREE.Group();
  world.add(splatGroup);
  const placed = (mesh: SplatMesh, s: SplatSide) => {
    if (s.transform) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(s.transform);
    }
    splatGroup.add(mesh);
    return mesh;
  };

  const showProgress = (f: number | null) => {
    if (f == null) return loaderFill.classList.add("indeterminate");
    loaderFill.style.width = `${Math.round(f * 100)}%`;
    loaderText.textContent = `Loading… ${Math.round(f * 100)}%`;
  };
  const onProgress = (e: ProgressEvent) => showProgress(e.lengthComputable ? e.loaded / e.total : null);
  /** Both sides loading at once: report their combined bytes. */
  const bytes = { old: [0, 0], new: [0, 0] };
  const sideProgress = (key: "old" | "new") => (e: ProgressEvent) => {
    bytes[key] = [e.loaded, e.lengthComputable ? e.total : 0];
    const total = bytes.old[1] + bytes.new[1];
    showProgress(bytes.old[1] && bytes.new[1] ? (bytes.old[0] + bytes.new[0]) / total : null);
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
  /** Both sides' meshes (not in region mode). */
  const sideMeshes: Partial<Record<"old" | "new", SplatMesh>> = {};
  const load = async () => {
    if (!regionMode) {
      const loadSide = (key: "old" | "new") => {
        const s = manifest[key];
        const url = opts.frontLayer ? s.url.replace(/\.spz$/, ".front.spz") : s.url;
        const mesh = new SplatMesh({
          url: new URL(url, baseUrl).href,
          lod: opts.lod ? (opts.lodQuality ? "quality" : true) : undefined,
          onProgress: sideProgress(key),
        });
        mesh.visible = key === current;
        meshes.push(mesh);
        sideMeshes[key] = placed(mesh, s);
        return mesh.initialized;
      };
      await Promise.all([loadSide("old"), loadSide("new")]);
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
    placed(detail, side);
    placed(low, side);
    await Promise.all([detail.initialized, low.initialized]);
  };

  const hud = new Hud();
  scene.add(hud.mesh);

  // Panel beside the view: a photo to select parts on (old or new), and its buttons.
  // A selection per source photo: parts of the old photo go into the new scene and
  // parts of the new photo into the old one.
  const selections: Partial<Record<Side, PartSelection>> = {};
  let photoSide: Side = "old";
  const activeSelection = () => selections[photoSide] ?? null;
  let panel: XrPhotoPanel | null = null;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const refreshPanel = () => {
    const selection = activeSelection();
    sideBtn.textContent = `Show ${otherSide()}: ${manifest[otherSide()].label}`;
    partBtn.textContent = `✂ ${cap(photoSide)} part` + (selection?.active ? ` (${selection.partCount})` : "");
    if (!panel) return;
    // Both photos selectable: the buttons pick the photo (the controllers' grip switches
    // the scene). Otherwise they switch the scene.
    const buttons: PanelButton[] =
      selections.old && selections.new
        ? (["old", "new"] as const).map((k) => ({ id: `photo:${k}`, label: `${cap(k)} photo`, active: photoSide === k }))
        : (["old", "new"] as const).map((k) => ({ id: k, label: `Show ${k}`, active: current === k }));
    let hint = "Old / New buttons, or grip anywhere off the panel, switch scenes";
    if (selection) {
      const sel = selection;
      const editing = sel.points.length > 0;
      const busy = sel.state === "segmenting";
      const partNo = sel.keptCount + 1;
      const kept = sel.keptCount;
      buttons.push(
        { id: "undo", label: "Undo", disabled: !editing && !sel.active },
        // The step people miss: without it, points for a second object get added to
        // the first one and SAM tries to make one mask covering both.
        { id: "next", label: "✓ Keep part", primary: editing, disabled: !editing || busy },
        { id: "clear", label: "Clear", disabled: !sel.active && !editing },
      );
      const keptNote = kept ? `${kept} kept part${kept > 1 ? "s" : ""} (blue). ` : "";
      hint =
        sel.state === "loading" ? "Loading segmentation…\nThe photo can be pointed at in a moment"
        : sel.state === "error" ? `Segmentation failed: ${sel.error}\nUndo or Clear to try again`
        : busy ? `Segmenting part ${partNo}…\nOne object per part: ✓ Keep part before starting the next object`
        : editing ? `Part ${partNo} (orange): happy with it? Press ✓ Keep part\nOnly add points on this SAME object. A different object needs a new part.`
        : kept ? `${keptNote}Point at another object to start part ${partNo}\nUndo removes the last kept part · grip off the panel switches old/new`
        : `Point at ONE object in the ${sel.source} photo to bring it into the ${sel.target} scene\nTrigger selects, grip on the photo removes an area · grip off the panel switches old/new`;
      panel.setSelection(sel.keptCoverage, sel.currentCoverage, sel.points);
    }
    panel.setButtons(buttons);
    panel.setHint(hint);
  };
  function showSide(key: "old" | "new") {
    current = key;
    if (sideMeshes.old) sideMeshes.old.visible = key === "old";
    if (sideMeshes.new) sideMeshes.new.visible = key === "new";
    for (const sel of Object.values(selections)) sel.setShowingTarget(key === sel.target);
    showStatus();
    refreshPanel();
    updateInfo();
  }
  refreshPanel();

  // Non-XR preview camera, and a separate parentless camera for XR so the head
  // pose is relative to the scene origin (= the capture viewpoint).
  const rig = new CameraRig(renderer.domElement, manifest.camera);
  const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 1000);

  const vrControls = new VrControls(root, () => xr);
  const xr = new SparkXr({
    renderer,
    mode: "vr",
    referenceSpaceType: "local",
    frameBufferScaleFactor: opts.framebufferScale,
    // Our own Enter/Exit buttons (VrControls) drive the session; Spark's click handler
    // goes on this detached element and never fires.
    element: document.createElement("span"),
    onReady: (supported) => {
      // Browsers only expose WebXR on secure pages: https, or http://localhost (e.g. over USB with adb reverse).
      const reason = !window.isSecureContext
        ? `VR blocked: plain http on ${location.hostname} isn't a secure page. Open http://localhost:${location.port}/?xr over USB (adb reverse tcp:${location.port} tcp:${location.port}), or allow this address under chrome://flags → "Insecure origins treated as secure"`
        : "VR not available in this browser (needs a headset)";
      vrStatus = supported ? "VR ready" : reason;
      showStatus();
      vrControls.setSupported(supported);
    },
    // The Quest browser may run at 90 Hz; start at 72 Hz (13.9 ms per frame instead of 11.1 ms).
    onEnterXr: () => {
      rateIndex = 0;
      return setRate();
    },
    onExitXr: () => vrControls.sessionEnded(),
  });
  renderer.xr.addEventListener("sessionstart", () => debug.log("three.js: sessionstart (setSession finished, frame loop handed to the session)", "ok"));
  renderer.xr.addEventListener("sessionend", () => debug.log("three.js: sessionend"));

  // A (right): splat count · B (right): hide splat · X (left): splat size · Y (left): refresh rate.
  // Right thumbstick press: back to the photo's viewpoint (tint low-detail regions in
  // region mode). Left thumbstick press: exit VR. Stick tilts move (xrLocomotion.ts).
  // xr-standard gamepad mapping: buttons[3] = thumbstick press, buttons[4] = A/X, buttons[5] = B/Y.
  const actions = {
    "left:3": () => vrControls.exit(),
    "right:4": () => (countIndex = (countIndex + 1) % COUNT_LEVELS.length),
    "right:5": () => (splatGroup.visible = !splatGroup.visible),
    "right:3": () => {
      if (!regionMode) return loco.reset();
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
    const label = manifest[current].label;
    hud.info = !splatGroup.visible
      ? `${label} HIDDEN (B) · ${flags}`
      : `${label} · A ${count} · X ${s.name} · Y ${hud.targetHz ? `${Math.round(hud.targetHz)} Hz` : "rate"} · ${flags}`;
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
      setupPanel();
      updateInfo();
      vrControls.setLoaded();
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const presenting = renderer.xr.isPresenting;
        let offset = 0;
        if (presenting) {
          vrControls.frame();
          pollButtons();
          // Head pose from the previous frame; one frame of lag is fine for steering.
          const head = renderer.xr.getCamera().matrixWorld;
          const session = renderer.xr.getSession();
          if (session) loco.update(session, head, dt);
          // Distance from the photo's viewpoint, for the stats.
          offset = loco.toScene(headPos.setFromMatrixPosition(head)).length();
        } else {
          rig.update(dt);
          headPos.setFromMatrixPosition(rig.camera.matrixWorld);
        }
        hud.mesh.visible = presenting;
        panel?.update(presenting);
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

  function setupPanel() {
    const { old: oldMesh, new: newMesh } = sideMeshes;
    if (!oldMesh || !newMesh) return; // region mode: one side only
    for (const side of ["old", "new"] as const) {
      if (!PartSelection.available(manifest, side)) continue;
      const [source, target] = side === "old" ? [oldMesh, newMesh] : [newMesh, oldMesh];
      selections[side] = new PartSelection(manifest, baseUrl, side, source, target, refreshPanel);
    }
    const first = selections.old ?? selections.new;
    if (first) {
      photoSide = first.source;
      // Bring the selected part into view as soon as it changes.
      const showTarget = () => {
        const sel = activeSelection();
        if (sel && current !== sel.target) showSide(sel.target);
      };
      const photoOf = (sel: PartSelection) => ({ url: sel.photoUrl, ...sel.photoSize });
      panel = new XrPhotoPanel(photoOf(first), {
        onPhoto: (x, y, positive) => {
          activeSelection()?.addPoint({ x, y, positive });
          showTarget();
        },
        onButton: (id) => {
          const sel = activeSelection();
          if (id === "old" || id === "new") showSide(id);
          else if (id === "photo:old" || id === "photo:new") {
            const next = selections[id === "photo:old" ? "old" : "new"];
            if (!next) return;
            photoSide = next.source;
            panel?.setPhoto(photoOf(next));
            void next.load().catch(() => {});
            showTarget();
            refreshPanel();
          } else if (id === "undo") sel?.undo();
          else if (id === "next") sel?.nextPart();
          else if (id === "clear") sel?.clear();
        },
        onSqueezeElsewhere: () => showSide(otherSide()),
      });
      void first.load().catch(() => {});
      partBtn.hidden = false;
      partBtn.addEventListener("click", async () => {
        const sel = activeSelection();
        if (!sel) return;
        const coverage = await pickFromPhoto(root, { imageUrl: sel.photoUrl, title: manifest[sel.source].label, segmenter: sel.load() });
        if (!coverage) return;
        sel.addPart(coverage);
        showTarget();
      });
    } else {
      panel = new XrPhotoPanel(null, {
        onPhoto: () => {},
        onButton: (id) => (id === "old" || id === "new") && showSide(id),
        onSqueezeElsewhere: () => showSide(otherSide()),
      });
    }
    scene.add(panel.group);
    panel.attachControllers(renderer, scene);
    showSide(current);
  }

  return {
    ready,
    xr,
    dispose() {
      vrControls.exit();
      for (const sel of Object.values(selections)) sel.dispose();
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      rig.dispose();
      for (const m of meshes) m.dispose();
      renderer.dispose();
      root.remove();
    },
  };
}

type VrState = "checking" | "unsupported" | "idle" | "starting" | "in-vr";

/** After this long in "starting", explain that Link can be slow on first launch. */
const SLOW_START_S = 20;

/**
 * Enter/Exit VR buttons plus a status line, replacing Spark's single toggle button.
 * The browser allows only one immersive session, and a request can take minutes to
 * resolve over Quest Link, so Enter is locked while a request is pending. A pending
 * request can't be aborted from JS: Exit then ends the session as soon as it arrives,
 * and "Reload page" force-ends it (navigating away always ends a session).
 */
class VrControls {
  private state: VrState = "checking";
  private startedAt = 0;
  private timer = 0;
  private cancelRequested = false;
  private error = "";
  /** The render loop only starts once the splats are loaded; until then a session would get no frames. */
  private loaded = false;
  /** XR frames rendered in this session, and the count at the last status update (for fps). */
  private frames = 0;
  private framesAtTick = 0;
  private tickAt = 0;
  private fps = 0;
  private readonly statusEl: HTMLDivElement;
  private readonly enterBtn: HTMLButtonElement;
  private readonly exitBtn: HTMLButtonElement;
  private readonly reloadBtn: HTMLButtonElement;

  constructor(root: HTMLElement, private readonly getXr: () => SparkXr) {
    const el = document.createElement("div");
    el.className = "vr-controls";
    el.innerHTML = `
      <div class="vr-status" role="status"></div>
      <div class="vr-buttons">
        <button type="button" class="btn btn-primary vr-enter">Enter VR</button>
        <button type="button" class="btn vr-exit">Exit VR</button>
        <button type="button" class="btn vr-reload">Reload page</button>
      </div>`;
    root.appendChild(el);
    this.statusEl = el.querySelector(".vr-status")!;
    this.enterBtn = el.querySelector(".vr-enter")!;
    this.exitBtn = el.querySelector(".vr-exit")!;
    this.reloadBtn = el.querySelector(".vr-reload")!;
    this.enterBtn.addEventListener("click", () => void this.enter());
    this.exitBtn.addEventListener("click", () => this.exit());
    this.reloadBtn.addEventListener("click", () => location.reload());
    this.render();
  }

  setSupported(supported: boolean) {
    if (this.state === "checking") this.setState(supported ? "idle" : "unsupported");
  }

  setLoaded() {
    this.loaded = true;
    this.render();
  }

  /** Call once per rendered XR frame. */
  frame() {
    this.frames++;
  }

  async enter() {
    if (this.state !== "idle" || !this.loaded) return;
    const xr = this.getXr();
    this.cancelRequested = false;
    this.error = "";
    this.startedAt = performance.now();
    this.setState("starting");
    console.info("[vr] requesting session…");
    // Spark's toggleXr logs and swallows its own errors; success = it stored a session.
    await xr.toggleXr();
    const session = xr.session;
    const seconds = ((performance.now() - this.startedAt) / 1000).toFixed(1);
    if (!session) {
      console.warn(`[vr] no session after ${seconds} s`);
      this.error = "Couldn't start VR (details in the console). If the headset still shows a session, use Reload page.";
      this.setState("idle");
      return;
    }
    console.info(`[vr] session started after ${seconds} s (headset: ${session.visibilityState})`);
    if (this.cancelRequested) {
      console.info("[vr] exit was requested while starting; ending session");
      void session.end();
      return;
    }
    session.addEventListener("visibilitychange", () => {
      console.info(`[vr] headset visibility: ${session.visibilityState} (after ${this.frames} frames)`);
      this.render();
    });
    this.frames = this.framesAtTick = 0;
    this.tickAt = performance.now();
    this.fps = 0;
    this.setState("in-vr");
  }

  /** Ends the session, or (while one is still starting) ends it as soon as it arrives. */
  exit() {
    if (this.state === "in-vr") {
      void this.getXr().session?.end();
    } else if (this.state === "starting") {
      this.cancelRequested = true;
      this.render();
    }
  }

  /** Called by SparkXr when the session ends for any reason (us, the headset, the browser). */
  sessionEnded() {
    console.info("[vr] session ended");
    this.cancelRequested = false;
    this.setState("idle");
  }

  private setState(state: VrState) {
    this.state = state;
    clearInterval(this.timer);
    if (state === "starting" || state === "in-vr") this.timer = window.setInterval(() => this.tick(), 1000);
    this.render();
  }

  private tick() {
    if (this.state === "in-vr") {
      const now = performance.now();
      this.fps = ((this.frames - this.framesAtTick) * 1000) / (now - this.tickAt);
      this.framesAtTick = this.frames;
      this.tickAt = now;
    }
    this.render();
  }

  private render() {
    const { state } = this;
    const waited = Math.round((performance.now() - this.startedAt) / 1000);
    let text: string;
    switch (state) {
      case "checking":
        text = "Checking for a headset…";
        break;
      case "unsupported":
        text = "No VR headset found";
        break;
      case "idle":
        text = this.error || (this.loaded ? "Not in VR" : "Loading splats… Enter VR unlocks when done");
        break;
      case "starting":
        text = this.cancelRequested
          ? `Exiting as soon as the headset answers… (${waited} s) — Reload page to force it`
          : `Starting VR… ${waited} s — keep the headset on` +
            (waited >= SLOW_START_S ? ". Link can take minutes the first time; don't click again" : "");
        break;
      case "in-vr": {
        const visibility = this.getXr().session?.visibilityState ?? "?";
        text = `In VR · ${this.frames} frames (${Math.round(this.fps)} fps) · headset: ${visibility} · left stick press or Exit VR to leave`;
        break;
      }
    }
    this.statusEl.textContent = text;
    this.statusEl.dataset.state = state;
    this.enterBtn.hidden = state !== "idle";
    this.enterBtn.disabled = !this.loaded;
    this.exitBtn.hidden = state !== "in-vr" && !(state === "starting" && !this.cancelRequested);
    this.reloadBtn.hidden = state !== "starting" && !this.error;
  }
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
