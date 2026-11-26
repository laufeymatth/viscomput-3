import type * as THREE from "three";

/**
 * Shows the headset's left eye on the page's canvas while in VR, for people
 * watching the PC screen. Copies the frame the headset already got (one blit), no
 * second render. Needs a non-multisampled XR layer (antialias: false), since a
 * scaling blit can't resolve multisampling.
 *
 * three.js sizes the canvas's drawing buffer to the whole XR framebuffer (both
 * eyes) while presenting, but CSS keeps it at the page size, so the eye is placed
 * in a rect that looks undistorted on screen, with black around it.
 */
export function mirrorXrFrame(renderer: THREE.WebGLRenderer, session: XRSession) {
  const layer = session.renderState.baseLayer;
  if (!layer?.framebuffer) return;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const canvas = gl.canvas as HTMLCanvasElement;
  const bufW = gl.drawingBufferWidth, bufH = gl.drawingBufferHeight;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (!bufW || !bufH || !cssW || !cssH) return;

  const eyeW = Math.floor(layer.framebufferWidth / 2), eyeH = layer.framebufferHeight;
  // Fit the eye's aspect into the canvas as it appears on screen (CSS pixels)...
  const showW = Math.min(cssW, (cssH * eyeW) / eyeH);
  const showH = (showW * eyeH) / eyeW;
  // ...then convert that rect to drawing-buffer pixels.
  const w = Math.round((showW * bufW) / cssW), h = Math.round((showH * bufH) / cssH);
  const x = Math.round((bufW - w) / 2), y = Math.round((bufH - h) / 2);

  const scissor = gl.isEnabled(gl.SCISSOR_TEST);
  if (scissor) gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.clear(gl.COLOR_BUFFER_BIT); // clear colour is black (setClearColor)
  gl.blitFramebuffer(0, 0, eyeW, eyeH, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
  // Back to what three.js has cached as bound.
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  if (scissor) gl.enable(gl.SCISSOR_TEST);
}
