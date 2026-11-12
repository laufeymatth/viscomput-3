// Contract between the (future) Python preprocessing backend and the viewer.

/** Pinhole camera of the source photo, in the splat file's own coordinates (OpenCV: +z forward, +y down). */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface SplatSide {
  /** Relative to the manifest's folder, or absolute. */
  url: string;
  label: string;
  /** Optional 4x4 column-major matrix (alignment result, axis flips, ...). */
  transform?: number[];
  /** Source photo the splat was made from. */
  image?: string;
  /** Precomputed SAM 2.1 image embeddings (tools/sam_embed.py). */
  sam?: string;
  intrinsics?: Intrinsics;
}

export interface CameraSpec {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view; match the capture's camera for least distortion. Default 60. */
  fovDeg?: number;
  /** Max orbit away from the start view, in degrees. */
  maxYawDeg: number;
  maxPitchDeg: number;
  minDistance: number;
  maxDistance: number;
}

export interface Manifest {
  title: string;
  old: SplatSide;
  new: SplatSide;
  camera: CameraSpec;
}

export async function loadManifest(id: string): Promise<{ manifest: Manifest; baseUrl: string }> {
  const baseUrl = new URL(`comparisons/${encodeURIComponent(id)}/`, new URL(import.meta.env.BASE_URL, location.href)).href;
  const res = await fetch(new URL("manifest.json", baseUrl));
  if (!res.ok) throw new Error(`Comparison "${id}" not found (${res.status})`);
  return { manifest: (await res.json()) as Manifest, baseUrl };
}
