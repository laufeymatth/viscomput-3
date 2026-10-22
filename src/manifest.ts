// Contract between the (future) Python preprocessing backend and the viewer.

export interface SplatSide {
  /** Relative to the manifest's folder, or absolute. */
  url: string;
  label: string;
  /** Optional 4x4 column-major matrix (alignment result, axis flips, ...). */
  transform?: number[];
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
