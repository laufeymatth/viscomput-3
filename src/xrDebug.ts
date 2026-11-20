/**
 * WebXR call log for the VR viewer: patches the browser's XR entry points so every
 * session request, layer setup, reference space and frame callback is timed and
 * logged, whoever makes the call (three.js, Spark or us). Shown in a panel on the
 * 2D page with a Copy button.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the WebXR prototypes are patched dynamically. */

const MAX_LINES = 400;
/** While a session has delivered no frames, repeat the frame counters this often. */
const NO_FRAME_REPORT_MS = 5000;

export interface XrDebugOptions {
  /**
   * Hide the WebXR Layers API so three.js falls back to a classic XRWebGLLayer.
   * Must run before the session starts; three checks at setSession time.
   */
  forceClassicLayer: boolean;
}

export class XrDebug {
  private readonly t0 = performance.now();
  private readonly lines: string[] = [];
  private readonly logEl: HTMLPreElement;
  private sessionStart = 0;
  private rafRequested = 0;
  private rafDelivered = 0;
  private rafThrew = 0;
  private reporter = 0;

  constructor(root: HTMLElement, opts: XrDebugOptions) {
    const panel = document.createElement("details");
    panel.className = "xr-debug";
    panel.open = true;
    panel.innerHTML = `
      <summary>XR log <button type="button" class="xr-debug-copy">Copy</button></summary>
      <pre class="xr-debug-log"></pre>`;
    root.appendChild(panel);
    this.logEl = panel.querySelector("pre")!;
    const copyBtn = panel.querySelector<HTMLButtonElement>(".xr-debug-copy")!;
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault(); // don't toggle the <details>
      try {
        await navigator.clipboard.writeText(this.lines.join("\n"));
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed: select the text";
      }
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });

    this.log(`browser: ${navigator.userAgent}`);
    this.install(opts);
  }

  log(msg: string, cls: "" | "ok" | "wait" | "err" = "") {
    const s = ((performance.now() - this.t0) / 1000).toFixed(2).padStart(7);
    const line = `${s} s  ${msg}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = line + "\n";
    this.logEl.appendChild(span);
    while (this.logEl.childNodes.length > MAX_LINES) this.logEl.firstChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
    (cls === "err" ? console.error : console.info)(`[xr] ${msg}`);
  }

  private sinceSession() {
    return `${((performance.now() - this.sessionStart) / 1000).toFixed(2)} s into session`;
  }

  private install(opts: XrDebugOptions) {
    const w = window as any;
    const self = this;

    window.addEventListener("error", (e) => this.log(`uncaught error: ${e.message} ${errStack(e.error)}`, "err"));
    window.addEventListener("unhandledrejection", (e) => this.log(`unhandled rejection: ${errText(e.reason)}`, "err"));

    if (!navigator.xr) {
      this.log("navigator.xr missing: no WebXR here", "err");
      return;
    }

    const binding = w.XRWebGLBinding;
    const hasLayers = !!binding && "createProjectionLayer" in binding.prototype;
    if (opts.forceClassicLayer && hasLayers) {
      delete binding.prototype.createProjectionLayer;
      const gone = !("createProjectionLayer" in binding.prototype);
      this.log(`classic layer: hid the WebXR Layers API so three.js uses XRWebGLLayer (${gone ? "ok" : "FAILED, still present"})`, gone ? "ok" : "err");
    } else {
      this.log(`WebXR Layers API: ${hasLayers ? "present, three.js will use a projection layer" : "absent, three.js will use XRWebGLLayer"}`);
    }

    // requestSession: timing, result and session events.
    const xr = navigator.xr as any;
    const origRequest = xr.requestSession.bind(xr);
    xr.requestSession = async (mode: string, init?: any) => {
      this.log(`→ requestSession('${mode}') ${JSON.stringify(init ?? {})}`);
      const started = performance.now();
      const waiting = setInterval(
        () => this.log(`  still waiting on requestSession (${Math.round((performance.now() - started) / 1000)} s)`, "wait"),
        NO_FRAME_REPORT_MS,
      );
      try {
        const session = await origRequest(mode, init);
        this.log(`✓ requestSession (${((performance.now() - started) / 1000).toFixed(2)} s), visibility ${session.visibilityState}`, "ok");
        this.watchSession(session);
        return session;
      } catch (e) {
        this.log(`✗ requestSession failed: ${errText(e)}`, "err");
        throw e;
      } finally {
        clearInterval(waiting);
      }
    };

    const S = w.XRSession?.prototype;
    if (!S) return;

    const origUpdate = S.updateRenderState;
    S.updateRenderState = function (state: any) {
      const parts: string[] = [];
      if (state?.baseLayer) parts.push(`baseLayer XRWebGLLayer ${state.baseLayer.framebufferWidth}×${state.baseLayer.framebufferHeight}`);
      if (state?.layers) parts.push(`layers [${state.layers.map(describeLayer).join(", ")}]`);
      for (const k of Object.keys(state ?? {})) if (k !== "baseLayer" && k !== "layers") parts.push(`${k}=${state[k]}`);
      self.log(`updateRenderState: ${parts.join(" · ") || "(empty)"}`);
      try {
        return origUpdate.call(this, state);
      } catch (e) {
        self.log(`✗ updateRenderState threw: ${errText(e)}`, "err");
        throw e;
      }
    };

    const origSpace = S.requestReferenceSpace;
    S.requestReferenceSpace = async function (type: string) {
      const started = performance.now();
      try {
        const space = await origSpace.call(this, type);
        self.log(`✓ requestReferenceSpace('${type}') (${((performance.now() - started) / 1000).toFixed(2)} s)`, "ok");
        return space;
      } catch (e) {
        self.log(`✗ requestReferenceSpace('${type}') failed: ${errText(e)}`, "err");
        throw e;
      }
    };

    // Frame callbacks: count what was asked for vs what the browser delivered,
    // and catch exceptions thrown inside a frame (they stop three.js's frame loop).
    const origRaf = S.requestAnimationFrame;
    S.requestAnimationFrame = function (cb: (t: number, f: unknown) => void) {
      self.rafRequested++;
      if (self.rafRequested === 1) self.log("→ first session.requestAnimationFrame (waiting for the browser to call it)");
      return origRaf.call(this, (t: number, frame: unknown) => {
        self.rafDelivered++;
        if (self.rafDelivered === 1) self.log(`✓ first XR frame delivered, ${self.sinceSession()}`, "ok");
        try {
          cb(t, frame);
        } catch (e) {
          self.rafThrew++;
          if (self.rafThrew <= 3) self.log(`✗ exception inside XR frame ${self.rafDelivered}: ${errText(e)} ${errStack(e)}`, "err");
          throw e;
        }
      });
    };

    if (binding?.prototype?.createProjectionLayer) {
      const origProj = binding.prototype.createProjectionLayer;
      binding.prototype.createProjectionLayer = function (init: any) {
        try {
          const layer = origProj.call(this, init);
          self.log(`createProjectionLayer ${JSON.stringify(init)} → ${describeLayer(layer)}`);
          return layer;
        } catch (e) {
          self.log(`✗ createProjectionLayer threw: ${errText(e)}`, "err");
          throw e;
        }
      };
    }

    const gl = (w.WebGL2RenderingContext ?? w.WebGLRenderingContext)?.prototype;
    if (gl?.makeXRCompatible) {
      const origCompat = gl.makeXRCompatible;
      gl.makeXRCompatible = async function () {
        const started = performance.now();
        try {
          await origCompat.call(this);
          self.log(`✓ makeXRCompatible (${((performance.now() - started) / 1000).toFixed(2)} s)`, "ok");
        } catch (e) {
          self.log(`✗ makeXRCompatible failed: ${errText(e)}`, "err");
          throw e;
        }
      };
    }
  }

  private watchSession(session: any) {
    this.sessionStart = performance.now();
    this.rafRequested = this.rafDelivered = this.rafThrew = 0;
    session.addEventListener("visibilitychange", () =>
      this.log(`visibility → ${session.visibilityState} (${this.rafDelivered} frames delivered)`),
    );
    session.addEventListener("inputsourceschange", (e: any) =>
      this.log(`input sources: +${e.added.length} −${e.removed.length}`),
    );
    session.addEventListener("end", () => {
      clearInterval(this.reporter);
      this.log(
        `session ended: ${this.rafDelivered} frames delivered of ${this.rafRequested} requested, ${this.rafThrew} threw`,
        this.rafDelivered ? "" : "err",
      );
    });
    clearInterval(this.reporter);
    let lastDelivered = -1;
    this.reporter = window.setInterval(() => {
      // Once frames flow, stay quiet; while none arrive, keep saying so.
      if (this.rafDelivered > 0 && lastDelivered > 0) return;
      if (this.rafDelivered !== lastDelivered || this.rafDelivered === 0) {
        this.log(
          `frames: requested ${this.rafRequested}, delivered ${this.rafDelivered}, threw ${this.rafThrew} · visibility ${session.visibilityState} · ${this.sinceSession()}`,
          this.rafDelivered ? "ok" : "wait",
        );
      }
      lastDelivered = this.rafDelivered;
    }, NO_FRAME_REPORT_MS);
  }
}

function describeLayer(layer: any) {
  if (!layer) return String(layer);
  const name = layer.constructor?.name ?? "layer";
  if ("textureWidth" in layer) return `${name} ${layer.textureWidth}×${layer.textureHeight} (array ${layer.textureArrayLength})`;
  if ("framebufferWidth" in layer) return `${name} ${layer.framebufferWidth}×${layer.framebufferHeight}`;
  return name;
}

function errText(e: unknown) {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function errStack(e: unknown) {
  const stack = e instanceof Error ? e.stack : undefined;
  // First two frames are enough to see whose code threw.
  return stack ? `\n      ${stack.split("\n").slice(1, 3).map((l) => l.trim()).join("\n      ")}` : "";
}
