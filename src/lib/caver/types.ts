/**
 * CAVER — shared types
 * ---------------------
 * CAVER (https://www.caver.cz) finds access tunnels from a starting point
 * (usually an enzyme's active site) to the protein surface.  Unlike HOLE
 * (which traces a single pore along a predefined channel vector), CAVER
 * discovers *multiple* tunnels radiating outward from the start point and
 * clusters them into families.
 *
 * The web app wraps the original Java `caver.jar` (CAVER 3.0.3) — the
 * algorithm itself is unchanged.  The .obj output (a Java-serialized
 * `caver.tunnels.Tunnels` object) is parsed by `parse-tunnels.ts` into the
 * plain JSON shapes below.
 */

/** A single sampled sphere along a CAVER tunnel (a vertex in the tunnel graph). */
export interface CaverTunnelPoint {
  x: number
  y: number
  z: number
  /** Sphere radius (Ångström) at this vertex. */
  r: number
}

/** One tunnel from a CAVER run — a polyline of spheres from start to surface. */
export interface CaverTunnel {
  /** Tunnel id (1-based, assigned by CAVER). */
  id: number
  /** Sequential number within its snapshot. */
  number: number
  /** Total tunnel length (Ångström). */
  length: number
  /** Cost function value (lower = more favourable). */
  cost: number
  /** Curvature (ratio of tunnel length to start–end distance; 1 = straight). */
  curvature: number
  /** Bottleneck (minimum) radius along the tunnel (Ångström). */
  bottleneck_radius: number
  /** 3D position of the bottleneck sphere. */
  bottleneck_position: [number, number, number] | null
  /** Cluster id (1-based) assigned by average-link clustering. */
  cluster_id: number
  /** Polyline of sampled spheres from start → surface. */
  points: CaverTunnelPoint[]
}

/** Summary statistics for a cluster of tunnels. */
export interface CaverClusterSummary {
  id: number
  /** Number of tunnels in this cluster. */
  n_tunnels: number
  /** Average bottleneck radius (Ångström). */
  avg_bottleneck: number
  /** Maximum bottleneck radius (Ångström). */
  max_bottleneck: number
  /** Average tunnel length (Ångström). */
  avg_length: number
  /** Average curvature. */
  avg_curvature: number
  /** Cluster priority (0–1, higher = more important pathway). */
  priority: number
  /** Average throughput (0–1). */
  avg_throughput: number
  /** Representative (cheapest) tunnel for visualization. */
  representative_tunnel_id: number | null
}

/** Full result of a CAVER run. */
export interface CaverResult {
  job_id: string
  /** Starting point (x, y, z) used for the search. */
  starting_point: [number, number, number]
  /** All tunnels found (typically 1 per cluster after deduplement). */
  tunnels: CaverTunnel[]
  /** Cluster summary table (one row per cluster). */
  clusters: CaverClusterSummary[]
  /** Summary statistics. */
  summary: {
    n_tunnels: number
    n_clusters: number
    max_bottleneck: number | null
    min_bottleneck: number | null
    probe_radius: number
    shell_radius: number
    shell_depth: number
  }
  /** Raw output files available for download. */
  files: string[]
  /** Tail of the CAVER log (for debugging / warnings). */
  log_tail: string
  returncode: number
  error: string | null
  warnings: string[]
}

/** Run-form parameters for CAVER. */
export interface CaverParams {
  /** Starting point x (Ångström). */
  start_x: string
  start_y: string
  start_z: string
  /** Probe radius (Ångström) — minimum radius for a tunnel to be reported. */
  probe_radius: string
  /** Shell radius (Ångström) — thickness of the molecular surface shell. */
  shell_radius: string
  /** Shell depth — number of Voronoi tessellation layers. */
  shell_depth: string
  /** Maximum search distance from the starting point (Ångström). */
  max_distance: string
  /** Desired radius for starting-point optimisation (Ångström). */
  desired_radius: string
  /** Number of approximating balls (4/6/8/12/20 — higher = more accurate). */
  number_of_approximating_balls: string
  /** Clustering threshold (Ångström) — max distance for two tunnels to
   *  belong to the same cluster. */
  clustering_threshold: string
  /** Maximum number of tunnels to search for. */
  max_number_of_tunnels: string
  /** Java heap size (MB). */
  java_heap: string
  /** Random seed (empty = random). */
  seed: string
  /** Residues to ignore (space-separated, e.g. "HOH WAT"). */
  ignore_residues: string
}

export const DEFAULT_CAVER_PARAMS: CaverParams = {
  start_x: '0',
  start_y: '0',
  start_z: '0',
  probe_radius: '0.9',
  shell_radius: '3',
  shell_depth: '4',
  max_distance: '3',
  desired_radius: '5',
  number_of_approximating_balls: '12',
  clustering_threshold: '3.5',
  max_number_of_tunnels: '10000',
  java_heap: '1500',
  seed: '1',
  ignore_residues: 'HOH WAT',
}

/** Distinct colours for the first N CAVER clusters. */
export const CAVER_CLUSTER_COLORS = [
  '#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#a855f7',
]
