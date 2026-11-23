import * as THREE from "three";
import { SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import { CameraRig } from "./cameraRig";
import { forceClassicXrLayer } from "./xrLayers";
import type { Manifest, SplatSide } from "./manifest";
import { PartSelection, type Side } from "./partSelection";
import { pickFromPhoto } from "./photoPicker";
import { XrPhotoPanel, type PanelButton } from "./xrPhotoPanel";
import { XrLocomotion } from "./xrLocomotion";

export interface XrOptions {
  /** Side shown first; both are loaded and can be switched live. */
  side: Side;
  /**
   * Load `<name>.front.spz` instead: SHARP's two splats per pixel merged into one
   * (scripts/spz-front-layer.mjs), half the splats for nearly the same look. Over
   * Link the full set can drop below the headset's frame rate.
   */
  front: boolean;
  /** WebXR render resolution as a fraction of the headset's recommended size. */
  framebufferScale: number;
  /**
   * Spark's level of detail: replaces splats smaller than a pixel by merged, softer
   * ones (about 875K instead of 1.18M drawn in VR). Faster, visibly blurrier.
   */
  lod: boolean;
}

/** `?xr&side=old&front=1&fb=0.75&lod=1` (defaults: new, full splats, fb 1, no LoD). */
export function parseXrOptions(params: URLSearchParams): XrOptions {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(params.get(key));
    return params.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  return {
    side: params.get("side") === "old" ? "old" : "new",
    front: params.get("front") === "1",
    framebufferScale: num("fb", 1, 0.25, 1.5),
    lod: params.get("lod") === "1",
  };
}

/**
 * WebXR viewer: both captures loaded, one shown at a time, with the photo's
 * viewpoint placed at the user's head (the "local" reference space origin is the
 * head pose at session start). A panel beside the view selects parts of either
 * photo to bring into the other scene; the thumbsticks move around. Outside VR it
 * falls back to the normal limited-orbit camera.
 *
 * All splats are drawn at full detail unless `lod=1`: Spark's LoD visibly blurred
 * SHARP captures.
 */
export function createXrViewer(container: HTMLElement, manifest: Manifest, baseUrl: string, opts: XrOptions) {
  // Must run before three.js sets up the session (Chrome over Quest Link gets no frames otherwise).
  forceClassicXrLayer();

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
  let current: Side = opts.side;
  let vrStatus = "checking VR…";
  const showStatus = () => (status.textContent = `${manifest[current].label} · ${vrStatus}`);
  showStatus();

  const otherSide = (): Side => (current === "new" ? "old" : "new");
  const sideBtn = document.createElement("button");
  sideBtn.type = "button";
  sideBtn.className = "btn";
  sideBtn.addEventListener("click", () => showSide(otherSide()));
  const partBtn = document.createElement("button");
  partBtn.type = "button";
  partBtn.className = "btn";
  partBtn.textContent = "✂ Old part";
  partBtn.hidden = true;
  $(".xr-options").append(sideBtn, partBtn);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  // The splat's own frame puts the photo's camera at the origin looking down -Z.
  // Inside the locomotion root, which the thumbsticks move (the panel stays with the user).
  const world = new THREE.Group();
  const loco = new XrLocomotion();
  loco.root.add(world);
  scene.add(loco.root);
  const placed = (mesh: SplatMesh, s: SplatSide) => {
    if (s.transform) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(s.transform);
    }
    world.add(mesh);
    return mesh;
  };

  /** Both sides load at once: report their combined bytes. */
  const bytes = { old: [0, 0], new: [0, 0] };
  const sideProgress = (key: Side) => (e: ProgressEvent) => {
    bytes[key] = [e.loaded, e.lengthComputable ? e.total : 0];
    const total = bytes.old[1] + bytes.new[1];
    if (!bytes.old[1] || !bytes.new[1]) return loaderFill.classList.add("indeterminate");
    const f = (bytes.old[0] + bytes.new[0]) / total;
    loaderFill.classList.remove("indeterminate");
    loaderFill.style.width = `${Math.round(f * 100)}%`;
    loaderText.textContent = `Loading… ${Math.round(f * 100)}%`;
  };
  const meshes: SplatMesh[] = [];
  const sideMeshes: Partial<Record<Side, SplatMesh>> = {};
  const load = async () => {
    const loadSide = (key: Side) => {
      const s = manifest[key];
      const url = opts.front ? s.url.replace(/\.spz$/, ".front.spz") : s.url;
      const mesh = new SplatMesh({ url: new URL(url, baseUrl).href, lod: opts.lod || undefined, onProgress: sideProgress(key) });
      mesh.visible = key === current;
      meshes.push(mesh);
      sideMeshes[key] = placed(mesh, s);
      return mesh.initialized;
    };
    await Promise.all([loadSide("old"), loadSide("new")]);
  };

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
        : `Point at ONE object in the ${sel.source} photo to bring it into the ${sel.target} scene\nTrigger selects · grip on the photo removes · grip elsewhere switches old/new`;
      panel.setSelection(sel.keptCoverage, sel.currentCoverage, sel.points);
    }
    panel.setButtons(buttons);
    panel.setHint(hint);
  };
  function showSide(key: Side) {
    current = key;
    if (sideMeshes.old) sideMeshes.old.visible = key === "old";
    if (sideMeshes.new) sideMeshes.new.visible = key === "new";
    for (const sel of Object.values(selections)) sel.setShowingTarget(key === sel.target);
    showStatus();
    refreshPanel();
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
    // Full resolution by default; Spark defaults to half.
    frameBufferScaleFactor: opts.framebufferScale,
    // Our own Enter/Exit buttons (VrControls) drive the session; Spark's click handler
    // goes on this detached element and never fires.
    element: document.createElement("span"),
    onReady: (supported) => {
      // Browsers only expose WebXR on secure pages: https, or http://localhost.
      const reason = !window.isSecureContext
        ? `VR blocked: plain http on ${location.hostname} isn't a secure page. Open http://localhost:${location.port}/?xr instead`
        : "VR not available in this browser (needs a headset)";
      vrStatus = supported ? "VR ready" : reason;
      showStatus();
      vrControls.setSupported(supported);
    },
    onExitXr: () => vrControls.sessionEnded(),
  });

  // Left thumbstick press: exit VR. Right thumbstick press: back to the photo's
  // viewpoint. Stick tilts move (xrLocomotion.ts).
  // xr-standard gamepad mapping: buttons[3] = thumbstick press.
  const actions: Record<string, () => unknown> = {
    "left:3": () => vrControls.exit(),
    "right:3": () => loco.reset(),
  };
  const pressed = new Set<string>();
  const pollButtons = (session: XRSession) => {
    for (const source of session.inputSources) {
      const key = `${source.handedness}:3`;
      const action = actions[key];
      if (!action || !source.gamepad) continue;
      const down = source.gamepad.buttons[3]?.pressed ?? false;
      if (down && !pressed.has(key)) action();
      if (down) pressed.add(key);
      else pressed.delete(key);
    }
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

  // Small stats line on the 2D page.
  const perfEl = $<HTMLPreElement>(".perf");
  const perf = new PerfMeter();
  const showPerf = (s: PerfSample) => {
    // In VR, also on the panel: below the headset's rate Link fills in frames by
    // warping old ones, which shows as black smeared patches while moving.
    const target = renderer.xr.isPresenting ? (renderer.xr.getSession()?.frameRate ?? 0) : 0;
    panel?.setFps(target ? `${Math.round(s.fps)}/${Math.round(target)} fps` : `${Math.round(s.fps)} fps`, !target || s.fps >= target * 0.95);
    perfEl.textContent = [
      `${s.fps.toFixed(0)} fps · ${s.avgMs.toFixed(1)} ms avg · ${s.worstMs.toFixed(0)} ms worst`,
      `drawn ${formatCount(spark.activeSplats)} splats${opts.front ? " (front layer)" : ""}${opts.lod ? " (LoD)" : ""} · fb ${opts.framebufferScale} · ${manifest[current].label}`,
    ].join("\n");
  };

  let last = performance.now();
  const ready = load()
    .then(() => {
      root.classList.remove("loading");
      setupPanel();
      vrControls.setLoaded();
      renderer.setAnimationLoop((now) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const presenting = renderer.xr.isPresenting;
        const session = renderer.xr.getSession();
        if (presenting && session) {
          vrControls.frame();
          pollButtons(session);
          // Head pose from the previous frame; one frame of lag is fine for steering.
          loco.update(session, renderer.xr.getCamera().matrixWorld, dt);
        } else {
          rig.update(dt);
        }
        panel?.update(presenting);
        renderer.render(scene, presenting ? xrCamera : rig.camera);
        const sample = perf.frame(now);
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
    if (!oldMesh || !newMesh) return;
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
}

/** Aggregates per-frame timings into one sample per second. */
class PerfMeter {
  private frames = 0;
  private windowStart = 0;
  private lastFrame = 0;
  private worstMs = 0;

  frame(now: number): PerfSample | null {
    if (this.lastFrame) this.worstMs = Math.max(this.worstMs, now - this.lastFrame);
    this.lastFrame = now;
    this.frames++;
    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return null;

    const sample = {
      fps: (this.frames * 1000) / elapsed,
      avgMs: elapsed / this.frames,
      worstMs: this.worstMs,
    };
    this.frames = 0;
    this.worstMs = 0;
    this.windowStart = now;
    return sample;
  }
}
