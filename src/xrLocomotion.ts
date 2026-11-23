import * as THREE from "three";

/** Left stick: walk speed (m/s) at full tilt. */
const MOVE_SPEED = 1.5;
/** Right stick up/down: rise/sink speed (m/s). */
const LIFT_SPEED = 0.75;
/** Right stick left/right: smooth turn speed at full tilt (rad/s). */
const TURN_SPEED = THREE.MathUtils.degToRad(90);
const DEADZONE = 0.15;

/**
 * Thumbstick movement through the splat scene. Instead of moving the camera (WebXR
 * owns the head pose), `root` holds the scene and is moved the opposite way, so
 * everything outside it (the photo panel, HUD, controllers) stays with the user.
 *
 * Left stick walks where you look (level, like walking), right stick left/right
 * turns smoothly around your head, right stick up/down rises and sinks.
 */
export class XrLocomotion {
  /** Put the splat scene inside this. */
  readonly root = new THREE.Group();
  /** Where the user's tracking space sits in the scene (user space → scene). */
  private readonly player = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();

  constructor() {
    this.root.matrixAutoUpdate = false;
  }

  /** Back to the photo's viewpoint. */
  reset() {
    this.player.identity();
    this.apply();
  }

  /** A point in the user's tracking space (e.g. the head) → scene coordinates. */
  toScene(v: THREE.Vector3) {
    return v.applyMatrix4(this.player);
  }

  /** head: the XR camera's world matrix (tracking space). */
  update(session: XRSession, head: THREE.Matrix4, dt: number) {
    let moveX = 0, moveY = 0, turn = 0, lift = 0;
    for (const source of session.inputSources) {
      const axes = source.gamepad?.axes;
      if (!axes) continue;
      // xr-standard: axes 2/3 are the thumbstick (0/1 the touchpad, absent on Quest).
      const x = axes.length >= 4 ? axes[2] : (axes[0] ?? 0);
      const y = axes.length >= 4 ? axes[3] : (axes[1] ?? 0);
      if (source.handedness === "left") {
        moveX = x;
        moveY = y;
      } else if (source.handedness === "right") {
        turn = x;
        lift = y;
      }
    }

    let changed = false;
    const headPos = new THREE.Vector3().setFromMatrixPosition(head);

    // Walk: stick forward = where the head faces, flattened so looking down doesn't dig in.
    if (Math.hypot(moveX, moveY) > DEADZONE) {
      this.forward.set(0, 0, -1).transformDirection(head).setY(0);
      if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
      this.forward.normalize();
      this.right.set(-this.forward.z, 0, this.forward.x);
      this.move
        .copy(this.forward)
        .multiplyScalar(-moveY)
        .addScaledVector(this.right, moveX)
        .multiplyScalar(MOVE_SPEED * dt);
      this.player.multiply(this.tmp.makeTranslation(this.move));
      changed = true;
    }

    if (Math.abs(lift) > DEADZONE * 2) {
      this.player.multiply(this.tmp.makeTranslation(0, -lift * LIFT_SPEED * dt, 0));
      changed = true;
    }

    // Smooth turn about the head (not the tracking origin), faster the further the stick
    // is pushed; squared so small tilts give fine control.
    if (Math.abs(turn) > DEADZONE) {
      const t = (Math.abs(turn) - DEADZONE) / (1 - DEADZONE);
      const angle = -Math.sign(turn) * t * t * TURN_SPEED * dt;
      this.player
        .multiply(this.tmp.makeTranslation(headPos.x, 0, headPos.z))
        .multiply(this.tmp.makeRotationY(angle))
        .multiply(this.tmp.makeTranslation(-headPos.x, 0, -headPos.z));
      changed = true;
    }

    if (changed) this.apply();
  }

  private apply() {
    this.root.matrix.copy(this.player).invert();
    this.root.matrixWorldNeedsUpdate = true;
  }
}
