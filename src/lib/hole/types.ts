/**
 * HOLE2 web app — shared types
 * --------------------------------
 * These types describe the data returned by the Python hole2 mini-service
 * (port 3001) and consumed by the React UI + three.js viewer.
 *
 * The wire format is identical to the original HOLE2 command-line output
 * (parsed server-side from hole_out.txt, *.sph and *.vmd_plot) so the
 * downloadable files match what the CLI produces byte-for-byte.
 */

/** Single sampled point along the pore centre-line (from hole_out.txt).
 *
 * The HOLE profile table has columns:
 *   cenxyz.cvec | radius | cen_line_D | sum{s/(area)} | (sampled/mid-point)
 * We capture each as a typed field below.
 */
export interface ProfileSample {
  /** Channel coordinate = cenxyz.cvec (dot product of the sphere centre
   *  with CVECT).  This is the abscissa HOLE itself uses for the pore graph. */
  t: number
  /** Pore radius at this sample (Ångström) — the "radius" column. */
  r: number
  /** Distance along the pore centre line (cen_line_D column). */
  cen_line_d: number
  /** Cumulative conductance integral sum{s/(area)} — used for G_macro. */
  cond_integral: number
  /** HOLE alternates "mid-point" and "sampled" rows; kept for parity. */
  kind: 'mid' | 'sampled'
}

/** Parsed pore-profile data (from hole stdout). */
export interface PoreProfile {
  /** Channel vector.  Null when HOLE auto-guessed it (cguess masks the
   *  value with "************************" in the log); we then recover it
   *  via PCA on the .sph sphere centres (see infer_channel_axis). */
  cvec: [number, number, number] | null
  /** Channel centre point.  Null when HOLE auto-guessed it (same as cvec). */
  cpoint: [number, number, number] | null
  samples: ProfileSample[]
  min_radius: number | null
  /** Channel coordinate of the constriction point (minimum radius). */
  min_t: number | null
  max_radius: number | null
  n_samples: number
  /** HOLE geometric factor F = Σ(ds/area). */
  g_factor: number | null
  /** Macroscopic predicted conductance G_macro (pS). */
  g_macro: number | null
  pore_length: number | null
}

/** Sphere centre from the .sph file (pseudo-PDB ATOM record). */
export interface HoleSphere {
  x: number
  y: number
  z: number
  r: number
}

/** Triangle from the .vmd_plot file (3 vertices + 3 normals). */
export interface HoleTriangle {
  /** v0, v1, v2 — each [x,y,z]. */
  vertices: [number, number, number][]
  /** n0, n1, n2 — each [x,y,z]. */
  normals: [number, number, number][]
  /** HOLE quanta colour name: red / green / blue (or 'end' for end-cap). */
  color: string
}

/** Parsed solid-surface mesh returned by the service. */
export interface HoleSurface {
  triangles: HoleTriangle[]
  colors: string[]
}

/** Summary card shown after a successful run. */
export interface RunSummary {
  status: 'ok' | 'error' | 'no_pore'
  min_radius: number | null
  /** Channel coordinate of the constriction point. */
  min_t: number | null
  max_radius: number | null
  pore_length: number | null
  n_samples: number
  g_factor: number | null
  g_macro: number | null
  n_spheres: number
  n_triangles: number
  /** The channel direction HOLE's auto-guess (cguess) picked (X/Y/Z).
   *  Surfaced when the trace failed so the user can verify it. */
  cguess_direction?: string | null
}

/** Raw output file produced by HOLE2 (for the downloads panel). */
export interface OutputFile {
  name: string
  size: number
  /** Human-friendly description shown in the UI. */
  description: string
}

/** Full result of a POST /api/run call. */
export interface RunResult {
  job_id: string
  profile: PoreProfile
  summary: RunSummary
  spheres: HoleSphere[]
  surface: HoleSurface
  centreline: [number, number, number][]
  files: string[]
  log_tail: string
  input_file: string
  returncode: number
  error: string | null
  /** Non-fatal warnings (e.g. sos_triangle polygon overflow on large pores). */
  warnings: string[]
}

/** Run-form parameters — match the Python service's POST /api/run schema. */
export interface RunParams {
  radius_set: string
  cpoint_x: string
  cpoint_y: string
  cpoint_z: string
  cvect_x: string
  cvect_y: string
  cvect_z: string
  endrad: string
  shorto: string
  connolly: boolean
  ignore_residues: string
  sphpdb_name: string
  dotden: string
  smooth_surface: boolean
}

export const DEFAULT_PARAMS: RunParams = {
  radius_set: 'simple',
  cpoint_x: '',
  cpoint_y: '',
  cpoint_z: '',
  cvect_x: '',
  cvect_y: '',
  cvect_z: '',
  endrad: '5.0',
  shorto: '0',
  connolly: false,
  ignore_residues: '',
  sphpdb_name: 'hole_out',
  dotden: '20',
  smooth_surface: true,
}

/** HOLE three-zone colour convention (red=too narrow for water, green=single water, blue=wide). */
export const HOLE_NARROW = 1.15
export const HOLE_MAX_GREEN = 2.30

export const PORE_ZONE_COLORS = {
  narrow: '#dc2626', // red — pore radius < 1.15 Å (water cannot pass)
  mid: '#16a34a',    // green — 1.15 ≤ r < 2.30 (single water file)
  wide: '#2563eb',   // blue — r ≥ 2.30 (double-water passage)
} as const

/** Map a pore radius to its HOLE zone colour. */
export function poreZoneColor(r: number): string {
  if (r < HOLE_NARROW) return PORE_ZONE_COLORS.narrow
  if (r < HOLE_MAX_GREEN) return PORE_ZONE_COLORS.mid
  return PORE_ZONE_COLORS.wide
}

/** Map a HOLE .vmd_plot colour name to a CSS hex colour. */
export function vmdColorToHex(name: string): string {
  switch (name.toLowerCase()) {
    case 'red': return '#dc2626'
    case 'green': return '#16a34a'
    case 'blue': return '#2563eb'
    case 'yellow': return '#eab308'
    case 'white': return '#e5e7eb'
    case 'gray': case 'grey': return '#6b7280'
    default: return '#16a34a'
  }
}
