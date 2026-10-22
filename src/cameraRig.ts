import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraSpec } from "./manifest";

const DEG = Math.PI / 180;
const GYRO_MAX_DEG = 5;
/** Degrees of camera offset per degree of device tilt. */
const GYRO_GAIN = 0.25;
const GYRO_SMOOTHING = 8;

type OrientationEventCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

/**
 * Orbit camera limited to a small cone around the start view, plus an optional
 * gyro tilt applied on top. OrbitControls drives `orbitCamera`; `camera` is what
 * gets rendered (orbit + gyro offset), so the gyro never feeds back into the orbit.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private readonly orbitCamera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private gyroOn = false;
  private gyroBase: { beta: number; gamma: number } | null = null;
  private readonly gyroTarget = new THREE.Vector2(); // yaw, pitch in radians
  private readonly gyroCurrent = new THREE.Vector2();
  private readonly onOrientation = (e: DeviceOrientationEvent) => this.handleOrientation(e);

  constructor(domElement: HTMLElement, spec: CameraSpec) {
    this.orbitCamera = new THREE.PerspectiveCamera(spec.fovDeg ?? 60, 1, 0.01, 1000);
    this.orbitCamera.position.fromArray(spec.position);
    this.camera = this.orbitCamera.clone();

    const controls = new OrbitControls(this.orbitCamera, domElement);
    controls.target.fromArray(spec.target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.rotateSpeed = 0.4;
    controls.minDistance = spec.minDistance;
    controls.maxDistance = spec.maxDistance;

    // OrbitControls limits are absolute spherical angles, so centre them on the start view.
    const start = new THREE.Spherical().setFromVector3(
      this.orbitCamera.position.clone().sub(controls.target),
    );
    controls.minAzimuthAngle = start.theta - spec.maxYawDeg * DEG;
    controls.maxAzimuthAngle = start.theta + spec.maxYawDeg * DEG;
    controls.minPolarAngle = Math.max(0.01, start.phi - spec.maxPitchDeg * DEG);
    controls.maxPolarAngle = Math.min(Math.PI - 0.01, start.phi + spec.maxPitchDeg * DEG);
    controls.update();
    controls.saveState();
    this.controls = controls;
  }

  get gyroEnabled() {
    return this.gyroOn;
  }

  /** Must be called from a user gesture (iOS permission prompt). Returns the new state. */
  async toggleGyro(): Promise<boolean> {
    if (this.gyroOn) {
      window.removeEventListener("deviceorientation", this.onOrientation);
      this.gyroOn = false;
      this.gyroTarget.set(0, 0);
      return false;
    }
    const Ctor = window.DeviceOrientationEvent as OrientationEventCtor | undefined;
    if (!Ctor) return false;
    if (typeof Ctor.requestPermission === "function") {
      if ((await Ctor.requestPermission()) !== "granted") return false;
    }
    this.gyroBase = null; // the pose at enable time becomes "neutral"
    window.addEventListener("deviceorientation", this.onOrientation);
    this.gyroOn = true;
    return true;
  }

  reset() {
    this.controls.reset();
    this.gyroBase = null;
  }

  setAspect(aspect: number) {
    for (const cam of [this.orbitCamera, this.camera]) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }

  update(deltaSeconds: number) {
    this.controls.update(deltaSeconds);

    const k = 1 - Math.exp(-GYRO_SMOOTHING * deltaSeconds);
    this.gyroCurrent.lerp(this.gyroTarget, k);

    // Rotate the orbit camera's offset around the target by the gyro yaw/pitch.
    const target = this.controls.target;
    const offset = new THREE.Spherical().setFromVector3(this.orbitCamera.position.clone().sub(target));
    offset.theta += this.gyroCurrent.x;
    offset.phi = THREE.MathUtils.clamp(offset.phi + this.gyroCurrent.y, 0.01, Math.PI - 0.01);
    this.camera.position.setFromSpherical(offset).add(target);
    this.camera.lookAt(target);
  }

  dispose() {
    window.removeEventListener("deviceorientation", this.onOrientation);
    this.controls.dispose();
  }

  private handleOrientation(e: DeviceOrientationEvent) {
    if (e.beta == null || e.gamma == null) return;
    if (!this.gyroBase) {
      this.gyroBase = { beta: e.beta, gamma: e.gamma };
      return;
    }
    const dBeta = e.beta - this.gyroBase.beta; // front/back tilt in portrait
    const dGamma = e.gamma - this.gyroBase.gamma; // left/right tilt in portrait

    // Map device axes to screen axes for the current orientation.
    const angle = screen.orientation?.angle ?? 0;
    let side: number, forward: number;
    if (angle === 90) [side, forward] = [dBeta, -dGamma];
    else if (angle === 270) [side, forward] = [-dBeta, dGamma];
    else if (angle === 180) [side, forward] = [-dGamma, -dBeta];
    else [side, forward] = [dGamma, dBeta];

    const max = GYRO_MAX_DEG * DEG;
    this.gyroTarget.set(
      THREE.MathUtils.clamp(-side * GYRO_GAIN * DEG, -max, max),
      THREE.MathUtils.clamp(-forward * GYRO_GAIN * DEG, -max, max),
    );
  }
}
