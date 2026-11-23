/**
 * Make three.js draw through a classic XRWebGLLayer instead of a WebXR Layers
 * projection layer. Chrome over Quest Link never delivers a single frame to a
 * projection-layer session, while XRWebGLLayer streams at full rate. three.js picks
 * the layer type when the session starts, so call this before that.
 */
export function forceClassicXrLayer() {
  const binding = (window as { XRWebGLBinding?: { prototype: Record<string, unknown> } }).XRWebGLBinding;
  if (binding && "createProjectionLayer" in binding.prototype) delete binding.prototype.createProjectionLayer;
}
