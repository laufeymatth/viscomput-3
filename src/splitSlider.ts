const TAP_MAX_MOVE_PX = 6;
const TAP_MAX_MS = 300;
const TAP_CYCLE = [0.5, 1, 0];

/**
 * Vertical divider the user drags to move the split. Lives above the canvas, so
 * touches that start on it never reach the orbit controls.
 */
export class SplitSlider {
  readonly element: HTMLElement;
  private value: number;
  private readonly onChange: (value: number) => void;

  constructor(container: HTMLElement, initial: number, onChange: (value: number) => void) {
    this.value = initial;
    this.onChange = onChange;

    this.element = document.createElement("div");
    this.element.className = "split-handle";
    this.element.setAttribute("role", "slider");
    this.element.setAttribute("aria-label", "Comparison split");
    this.element.setAttribute("aria-valuemin", "0");
    this.element.setAttribute("aria-valuemax", "100");
    this.element.tabIndex = 0;
    this.element.innerHTML = `<div class="split-line"></div><div class="split-knob" aria-hidden="true">‹ ›</div>`;
    container.appendChild(this.element);

    this.element.addEventListener("pointerdown", (e) => this.startDrag(e));
    this.element.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowLeft") this.set(this.value - step);
      else if (e.key === "ArrowRight") this.set(this.value + step);
      else return;
      e.preventDefault();
    });
    this.apply();
  }

  get split() {
    return this.value;
  }

  set(value: number) {
    this.value = Math.min(1, Math.max(0, value));
    this.apply();
    this.onChange(this.value);
  }

  private apply() {
    this.element.style.left = `${this.value * 100}%`;
    this.element.setAttribute("aria-valuenow", String(Math.round(this.value * 100)));
  }

  private startDrag(down: PointerEvent) {
    down.preventDefault();
    const el = this.element;
    el.setPointerCapture(down.pointerId);
    el.classList.add("dragging");
    const parent = el.parentElement!.getBoundingClientRect();
    const startTime = performance.now();
    let moved = false;

    const move = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - down.clientX) < TAP_MAX_MOVE_PX) return;
      moved = true;
      this.set((e.clientX - parent.left) / parent.width);
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!moved && performance.now() - startTime < TAP_MAX_MS) this.cycle();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /** Tap: 50% → all old → all new → 50%. */
  private cycle() {
    const i = TAP_CYCLE.findIndex((v) => Math.abs(v - this.value) < 0.01);
    this.set(TAP_CYCLE[(i + 1) % TAP_CYCLE.length]);
  }
}
