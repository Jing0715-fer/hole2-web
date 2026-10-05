/**
 * HOLE2 pipeline runner — TypeScript port of the original Python
 * `mini-services/hole2-service/main.py`.
 *
 * Everything runs in-process inside a Next.js route handler — no separate
 * Python service.  The HOLE2 binaries (hole, sph_process, sos_triangle,
 * qpt_conv) live in `vendor/hole2/bin/` and are spawned with
 * `child_process.execFileSync`/`spawnSync`.
 *
 * Pipeline (per job, in `/tmp/hole2-jobs/{job_id}/`):
 *   1. Write the PDB file + .rad file + hole.inp
 *   2. Run `hole` — reads hole.inp on stdin, writes hole_out.txt + .sph
 *   3. Parse hole stdout → PoreProfile (samples, cvec/cpoint, Gmacro)
 *   4. Detect "no pore" (0 samples + 99999 sentinel) → return actionable hints
 *   5. Run `sph_process` twice (dot-surface .qpt + solid surface .sos)
 *   6. Run `sos_triangle` (.sos on stdin → VMD `draw trinorm` / `draw triangle`
 *      commands on stdout).  Auto-fallback: if "Maximum number of polygons
 *      exceeded", regenerate the .sos at dotden=5 in faceted mode and retry.
 *   7. Run `qpt_conv` (best-effort, 5 s timeout — the bundled build hangs on
 *      its interactive prompt feed; the conda-forge build does not).
 *   8. Parse the .sph + .vmd_plot files into structured data for the UI.
 *   9. Infer cvec/cpoint via PCA when HOLE masks them with `****************`.
 */

import { spawnSync } from 'child_process'
import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync,
  writeFileSync, readFileSync, unlinkSync, rmdirSync,
} from 'fs'
import path from 'path'
import os from 'os'
import { randomBytes } from 'crypto'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd()
const VENDOR_HOLE2 = path.join(PROJECT_ROOT, 'vendor', 'hole2')
const VENDOR_BIN = path.join(VENDOR_HOLE2, 'bin')
const VENDOR_RAD = path.join(VENDOR_HOLE2, 'rad')
const VENDOR_EXAMPLES = path.join(VENDOR_HOLE2, 'examples')

// Repo-local examples (TRPM8 9PB6 demo with its recommended parameters).
const LOCAL_EXAMPLES = path.join(PROJECT_ROOT, 'mini-services', 'hole2-service', 'examples')

// Persistent jobs directory — survives across requests so the download
// endpoints can stream files afterwards.
export const JOBS_DIR =
  process.env.HOLE2_JOBS_DIR || path.join(os.tmpdir(), 'hole2-jobs')

// Hardening constants (match the original Python service).
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB
export const MAX_RAD_BYTES = 1 * 1024 * 1024 // 1 MB
export const MAX_CONCURRENT_RUNS = 2

const JOB_ID_RE = /^[0-9a-f]{12}$/
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/
const IGNORE_RE = /^[A-Za-z0-9 _-]+$/

// HOLE's no-pore sentinel: "Minimum radius found:  99999.000 angstroms."
const NO_PORE_SENTINEL = 9999.0

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Resolve a HOLE2 binary path (always bundled vendor/bin/). */
export function envBin(name: string): string {
  return path.join(VENDOR_BIN, name)
}

/** Return true if the bundled `hole` binary is executable. */
export function envExists(): boolean {
  const p = envBin('hole')
  return existsSync(p)
}

/**
 * Run a HOLE2 binary as a child process (synchronous — wrapped in
 * `runHolePipeline` which is itself awaited by the route handler).
 *
 * The binaries are pre-compiled ELF executables that only need the system
 * `libgfortran.so.5`.  We prepend the bin dir to PATH so the binaries can
 * find each other (and any system utilities they shell out to).
 */
export interface ProcResult {
  returncode: number
  stdout: string
  stderr: string
}

export function runInEnv(
  args: string[],
  opts: { cwd: string; input?: Buffer | string | null; timeout?: number } = { cwd: process.cwd() },
): ProcResult {
  const env = { ...process.env }
  const binDir = VENDOR_BIN
  const libDir = path.join(VENDOR_HOLE2, 'lib')
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ''}`
  // Prepend bundled lib dir so the HOLE2 binaries can find libgfortran.so.5
  // even on systems where it's not installed (e.g. minimal Docker/FC images).
  env.LD_LIBRARY_PATH = `${libDir}${path.delimiter}${env.LD_LIBRARY_PATH ?? ''}`

  const input = opts.input ?? null
  try {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: opts.cwd,
      input: input === null ? undefined : (typeof input === 'string' ? Buffer.from(input) : input),
      env,
      timeout: opts.timeout ?? 300_000,
      maxBuffer: 256 * 1024 * 1024, // 256 MB — large cryo-EM structures can print long logs
      encoding: 'utf-8' as const,
    })
    return {
      returncode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  } catch (e) {
    return {
      returncode: -1,
      stdout: '',
      stderr: (e as Error).message,
    }
  }
}

// ---------------------------------------------------------------------------
// Parsed-output types
// ---------------------------------------------------------------------------

export interface ProfileSample {
  /** Channel coordinate = cenxyz.cvec (dot product of sphere centre with CVECT). */
  t: number
  /** Pore radius at this sample (Å). */
  r: number
  /** Distance along the centre line (cen_line_D column). */
  cen_line_d: number
  /** Cumulative conductance integral sum{s/(area)}. */
  cond_integral: number
  /** "mid" or "sampled" — HOLE alternates the two. */
  kind: 'mid' | 'sampled'
}

export interface PoreProfile {
  cvec: [number, number, number] | null
  cpoint: [number, number, number] | null
  samples: ProfileSample[]
  min_radius: number | null
  min_t: number | null
  max_radius: number | null
  n_samples: number
  g_factor: number | null
  g_macro: number | null
  pore_length: number | null
}

export interface HoleSphere {
  x: number
  y: number
  z: number
  r: number
  /** resSeq number — HOLE uses sentinels: -888 (end), -999 (Connolly cloud). */
  idx: number
}

export interface HoleTriangle {
  /** v0, v1, v2 — each [x,y,z]. */
  vertices: [number, number, number][]
  /** n0, n1, n2 — each [x,y,z]. */
  normals: [number, number, number][]
  /** HOLE colour name (red / green / blue / yellow / ...). */
  color: string
}

export interface HoleSurface {
  triangles: HoleTriangle[]
  colors: string[]
}

// ---------------------------------------------------------------------------
// Parsers — extract structured data from the raw hole stdout + .sph file
// ---------------------------------------------------------------------------

// Matches a HOLE profile-table line.  The 4 numeric columns are:
//   col 1 = cenxyz.cvec (channel coordinate t)
//   col 2 = radius (pore radius in Å)
//   col 3 = cen_line_D (distance along centre line)
//   col 4 = sum{s/(area)} (conductance integral)
// Connolly mode appends extra columns before the (mid-point|sampled) tag:
//   31.56571   4.21656  12.36435   0.35151 1000000.000   6.506   0.149  (sampled)
const PROFILE_LINE =
  /^\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+).{0,80}\((mid-point|sampled)\)\s*$/

const MIN_RADIUS = /Minimum radius found:\s+(-?\d+\.\d+)/i
const CVECT = /channel vector:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/i
const CPOINT = /point in channel:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/i
const CGUESS_CVECT = /^CVECT\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/im
const CGUESS_CPOINT = /^CPOINT\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/im
const G_FACTOR = /F=\s*sum\(ds\/area\).*?is\s+(-?\d+\.\d+)/i
const GMACRO = /Gmacro=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i
const GMACRO_TAG =
  /TAG\s+\d+\s+Rmin=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+Gmacro=\s*(Infinity|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i
const BEST_DIRECTION = /Best direction is found to be\s+(\d)/
const ERROR_LINES = /^.*\bERROR\b.*$/gim

/** Parse the human-readable hole stdout into a structured PoreProfile. */
export function parseHoleStdout(text: string): PoreProfile {
  const prof: PoreProfile = {
    cvec: null,
    cpoint: null,
    samples: [],
    min_radius: null,
    min_t: null,
    max_radius: null,
    n_samples: 0,
    g_factor: null,
    g_macro: null,
    pore_length: null,
  }

  // cvec / cpoint — HOLE masks these with "************************" when it
  // auto-guesses via cguess.  cguess also prints the actual values on separate
  // CVECT/CPOINT lines right after the masking — we try the explicit line first,
  // then fall back to the cguess-printed line.
  const cv = text.match(CVECT)
  if (cv) {
    prof.cvec = [parseFloat(cv[1]), parseFloat(cv[2]), parseFloat(cv[3])]
  } else {
    const cvg = text.match(CGUESS_CVECT)
    if (cvg) prof.cvec = [parseFloat(cvg[1]), parseFloat(cvg[2]), parseFloat(cvg[3])]
  }
  const cp = text.match(CPOINT)
  if (cp) {
    prof.cpoint = [parseFloat(cp[1]), parseFloat(cp[2]), parseFloat(cp[3])]
  } else {
    const cpg = text.match(CGUESS_CPOINT)
    if (cpg) prof.cpoint = [parseFloat(cpg[1]), parseFloat(cpg[2]), parseFloat(cpg[3])]
  }

  // Profile samples — capture the 4 columns from each (sampled/mid-point) line
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(PROFILE_LINE)
    if (!m) continue
    const t = parseFloat(m[1]) // cenxyz.cvec — channel coordinate
    const r = parseFloat(m[2]) // radius — pore radius (Å)
    const cenLineD = parseFloat(m[3])
    const condInt = parseFloat(m[4])
    const kind: 'mid' | 'sampled' = m[5] === 'mid-point' ? 'mid' : 'sampled'
    prof.samples.push({
      t, r, cen_line_d: cenLineD, cond_integral: condInt, kind,
    })
  }

  const mn = text.match(MIN_RADIUS)
  if (mn) prof.min_radius = parseFloat(mn[1])

  const gf = text.match(G_FACTOR)
  if (gf) prof.g_factor = parseFloat(gf[1])

  // Gmacro: prefer the TAG summary line (also carries Rmin); fall back to the
  // plain "Gmacro=" line. Both regexes accept exponent notation.
  const gm = text.match(GMACRO_TAG)
  if (gm && gm[2].toLowerCase() !== 'infinity') {
    prof.g_macro = parseFloat(gm[2])
  } else {
    const gm2 = text.match(GMACRO)
    if (gm2) {
      const v = parseFloat(gm2[1])
      if (!Number.isNaN(v)) prof.g_macro = v
    }
  }

  if (prof.samples.length > 0) {
    prof.n_samples = prof.samples.length
    const rs = prof.samples.map((s) => s.r)
    prof.max_radius = Math.max(...rs)
    const ts = prof.samples.map((s) => s.t)
    prof.pore_length = Math.max(...ts) - Math.min(...ts)
    // Constriction point — the sample with the smallest radius.
    let minIdx = 0
    for (let i = 1; i < prof.samples.length; i++) {
      if (prof.samples[i].r < prof.samples[minIdx].r) minIdx = i
    }
    prof.min_radius = prof.samples[minIdx].r
    prof.min_t = prof.samples[minIdx].t
  } else if (prof.min_radius !== null && prof.min_radius >= NO_PORE_SENTINEL) {
    // HOLE traced nothing (e.g. it could not find a path from cpoint to solvent
    // below endrad) and printed its 99999 "no pore" sentinel.
    prof.min_radius = null
  }
  return prof
}

/** Infer the pore channel axis + centre via PCA on the .sph sphere centres.
 *
 *  HOLE masks cvec/cpoint with "************************" in the log when it
 *  auto-guesses them.  We recover the channel direction by Jacobi
 *  eigen-decomposition of the 3×3 covariance matrix of the sphere centres —
 *  the dominant eigenvector IS the channel direction.  The centroid is a
 *  good approximation of cpoint.
 *
 *  Returns [cvecUnit, cpoint] or [[0,0,1], [0,0,0]] if too few spheres.
 */
export function inferChannelAxis(
  spheres: HoleSphere[],
): [[number, number, number], [number, number, number]] {
  if (spheres.length < 4) {
    return [[0, 0, 1], [0, 0, 0]]
  }
  const n = spheres.length
  let cx = 0, cy = 0, cz = 0
  for (const s of spheres) { cx += s.x; cy += s.y; cz += s.z }
  cx /= n; cy /= n; cz /= n

  let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0
  for (const s of spheres) {
    const dx = s.x - cx, dy = s.y - cy, dz = s.z - cz
    sxx += dx * dx; syy += dy * dy; szz += dz * dz
    sxy += dx * dy; sxz += dx * dz; syz += dy * dz
  }
  // Symmetric 3×3 covariance matrix (row-major).
  const m = [
    sxx / n, sxy / n, sxz / n,
    sxy / n, syy / n, syz / n,
    sxz / n, syz / n, szz / n,
  ]
  // Eigenvectors — start with the identity.
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  for (let iter = 0; iter < 50; iter++) {
    let off = 0
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        off += m[i * 3 + j] * m[i * 3 + j]
      }
    }
    if (off < 1e-18) break

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const mpq = m[p * 3 + q]
        if (Math.abs(mpq) < 1e-16) continue
        const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * mpq)
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // Zero out m[p,q] via Givens rotation
        for (let k = 0; k < 3; k++) {
          const mkp = m[k * 3 + p]
          const mkq = m[k * 3 + q]
          m[k * 3 + p] = c * mkp - s * mkq
          m[k * 3 + q] = s * mkp + c * mkq
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p * 3 + k]
          const mqk = m[q * 3 + k]
          m[p * 3 + k] = c * mpk - s * mqk
          m[q * 3 + k] = s * mpk + c * mqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p]
          const vkq = v[k * 3 + q]
          v[k * 3 + p] = c * vkp - s * vkq
          v[k * 3 + q] = s * vkp + c * vkq
        }
      }
    }
  }

  // Eigenvalues = m[0], m[4], m[8]; eigenvectors = columns of v.
  const vals = [m[0], m[4], m[8]]
  const vecs: [number, number, number][] = [
    [v[0], v[3], v[6]],
    [v[1], v[4], v[7]],
    [v[2], v[5], v[8]],
  ]
  // Pick the eigenvector with the largest eigenvalue = channel direction.
  let best = 0
  for (let i = 1; i < 3; i++) if (vals[i] > vals[best]) best = i
  const axis = vecs[best]
  const norm = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2])
  if (norm < 1e-12) {
    return [[0, 0, 1], [cx, cy, cz]]
  }
  const cvec: [number, number, number] = [axis[0] / norm, axis[1] / norm, axis[2] / norm]
  return [cvec, [cx, cy, cz]]
}

/** Parse a HOLE .sph file (pseudo-PDB) into a compact list of sphere dicts.
 *
 *  Each ATOM record represents one pore-sphere centre.  resSeq sentinels:
 *    -888 = end marker spheres at the pore exits (skipped)
 *    -999 = Connolly-probe sampling cloud (kept, but excluded from the
 *           centre line by `centreLineSpheres`)
 *    0, 1, 2, ... / -1, -2, ... = the actual pore centre-line spheres.
 */
export function parseSphFile(filePath: string): HoleSphere[] {
  const out: HoleSphere[] = []
  if (!existsSync(filePath)) return out
  const text = readFileSync(filePath, 'utf-8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue
    let resSeq = 0
    try {
      resSeq = parseInt(line.slice(22, 26).trim(), 10) || 0
    } catch { /* keep 0 */ }
    if (resSeq === -888) continue // skip end markers
    try {
      const x = parseFloat(line.slice(30, 38).trim())
      const y = parseFloat(line.slice(38, 46).trim())
      const z = parseFloat(line.slice(46, 54).trim())
      const bfac = parseFloat(line.slice(60, 66).trim()) // B-factor = pore radius
      if ([x, y, z, bfac].some((v) => Number.isNaN(v))) continue
      out.push({ x, y, z, r: bfac, idx: resSeq })
    } catch { /* skip bad line */ }
  }
  return out
}

/** Return only the real pore centre-line spheres (exclude the -999 Connolly cloud). */
export function centreLineSpheres(spheres: HoleSphere[]): HoleSphere[] {
  return spheres.filter((s) => s.idx !== -999)
}

/** Parse a sos_triangle-generated .vmd_plot file.
 *
 *  Returns `{ triangles, colors }`.
 *
 *  sos_triangle has two output modes:
 *    - Smooth (-s):  `draw trinorm  {v0} {v1} {v2} {n0} {n1} {n2}`
 *      (6 triples — 3 vertices + 3 normals)
 *    - Faceted (default):  `draw triangle  {v0} {v1} {v2}`
 *      (3 triples — vertices only, no normals; we compute the face normal
 *      via the cross product of two edges)
 */
export function parseSosVmd(filePath: string): HoleSurface {
  const tris: HoleTriangle[] = []
  const colors: string[] = []
  let curColor = ''
  if (!existsSync(filePath)) return { triangles: tris, colors }

  const text = readFileSync(filePath, 'utf-8')
  const tripleRe = /\{\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\}/g

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line) continue
    if (line.startsWith('draw color')) {
      curColor = line.slice('draw color'.length).trim()
      continue
    }
    if (line.startsWith('draw trinorm')) {
      // Smooth mode: 6 triples = 3 vertices + 3 normals
      const matches = [...line.matchAll(tripleRe)]
      if (matches.length === 6) {
        const v = matches.map((m) => [
          parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]),
        ] as [number, number, number])
        tris.push({ vertices: v.slice(0, 3), normals: v.slice(3), color: curColor })
        colors.push(curColor)
      }
    } else if (line.startsWith('draw triangle')) {
      // Faceted mode: 3 triples = vertices only, no normals.
      const matches = [...line.matchAll(tripleRe)]
      if (matches.length === 3) {
        const v = matches.map((m) => [
          parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]),
        ] as [number, number, number])
        const e1: [number, number, number] = [
          v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2],
        ]
        const e2: [number, number, number] = [
          v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2],
        ]
        let nx = e1[1] * e2[2] - e1[2] * e2[1]
        let ny = e1[2] * e2[0] - e1[0] * e2[2]
        let nz = e1[0] * e2[1] - e1[1] * e2[0]
        const norm = Math.sqrt(nx * nx + ny * ny + nz * nz)
        if (norm > 1e-12) { nx /= norm; ny /= norm; nz /= norm }
        const n: [number, number, number] = [nx, ny, nz]
        tris.push({ vertices: v, normals: [n, n, n], color: curColor })
        colors.push(curColor)
      }
    }
    // "draw line" / "draw point" — centre-line dots; ignored.
  }
  return { triangles: tris, colors }
}

// ---------------------------------------------------------------------------
// HOLE2 run pipeline
// ---------------------------------------------------------------------------

/** Parameters accepted by runHolePipeline (matches the Python service's schema). */
export interface RunParamsInternal {
  radius_set: string
  cpoint_x: number | null
  cpoint_y: number | null
  cpoint_z: number | null
  cvect_x: number | null
  cvect_y: number | null
  cvect_z: number | null
  endrad: number
  shorto: number
  connolly: boolean
  ignore_residues: string
  sphpdb_name: string
  dotden: number
  smooth_surface: boolean
}

export interface RunResult {
  job_id: string
  work_dir: string
  profile: PoreProfile
  spheres: HoleSphere[]
  surface: HoleSurface
  summary: Record<string, unknown>
  files: string[]
  log_tail: string
  returncode: number
  error: string | null
  warnings: string[]
  centreline: [number, number, number][]
}

/** Construct a HOLE input file (.inp) from the web-form parameters. */
export function buildHoleInput(
  params: RunParamsInternal,
  pdbName: string,
  radPath: string,
  sphpdbName: string,
): string {
  const lines: string[] = []
  lines.push(`coord ${pdbName}`)
  lines.push(`radius ${radPath}`)
  if (params.ignore_residues) lines.push(`ignore ${params.ignore_residues}`)
  if (params.connolly) lines.push('CONNOLLY')
  if (
    params.cvect_x !== null && params.cvect_y !== null && params.cvect_z !== null
  ) {
    lines.push(
      `cvect ${params.cvect_x.toFixed(4)} ${params.cvect_y.toFixed(4)} ${params.cvect_z.toFixed(4)}`,
    )
  }
  if (
    params.cpoint_x !== null && params.cpoint_y !== null && params.cpoint_z !== null
  ) {
    lines.push(
      `cpoint ${params.cpoint_x.toFixed(4)} ${params.cpoint_y.toFixed(4)} ${params.cpoint_z.toFixed(4)}`,
    )
  }
  if (params.shorto !== null) lines.push(`shorto ${Math.trunc(params.shorto)}`)
  lines.push(`sphpdb ${sphpdbName}.sph`)
  lines.push(`endrad ${params.endrad.toFixed(2)}`)
  return lines.join('\n') + '\n'
}

/** Run the full HOLE2 pipeline on the given PDB and return parsed results. */
export function runHolePipeline(
  pdbBytes: Buffer,
  pdbName: string,
  params: RunParamsInternal,
  customRad: Buffer | null,
): RunResult {
  if (!envExists()) {
    throw new Error(
      'HOLE2 binaries are not available at vendor/hole2/bin/. ' +
      'Clone the repo recursively or download the HOLE2 binaries.',
    )
  }

  // Make sure the jobs directory exists.
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true })

  const jobId = randomBytes(6).toString('hex')
  const workDir = path.join(JOBS_DIR, jobId)
  mkdirSync(workDir, { recursive: true })

  // 1. Write the PDB file (basename-only, force .pdb extension).
  let safePdb = pdbName ? path.basename(pdbName) : 'input.pdb'
  if (!safePdb.endsWith('.pdb')) safePdb += '.pdb'
  const pdbPath = path.join(workDir, safePdb)
  writeFileSync(pdbPath, pdbBytes)

  // 2. Pick / write the radius file.
  let radPath: string
  if (customRad && customRad.length > 0) {
    radPath = path.join(workDir, 'custom.rad')
    writeFileSync(radPath, customRad)
  } else {
    const radSet = params.radius_set || 'simple'
    const bundled = path.join(VENDOR_RAD, `${radSet}.rad`)
    if (!existsSync(bundled)) {
      throw new Error(`Unknown radius set: ${radSet}`)
    }
    radPath = path.join(workDir, `${radSet}.rad`)
    copyFileSync(bundled, radPath)
  }

  // 3. Write the hole.inp file (also fed to hole via stdin).
  const sphpdbName = params.sphpdb_name || 'hole_out'
  const inpText = buildHoleInput(params, safePdb, radPath, sphpdbName)
  writeFileSync(path.join(workDir, 'hole.inp'), inpText)

  // 4. Run `hole` — reads hole.inp on stdin, writes hole_out.txt + .sph.
  let out = '', err = '', rc = 0
  try {
    const r = runInEnv([envBin('hole')], { cwd: workDir, input: inpText, timeout: 300_000 })
    out = r.stdout; err = r.stderr; rc = r.returncode
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('TIMED OUT') || msg.includes('timeout')) {
      throw new Error(
        'The HOLE binary timed out (>300 s) on this structure — it may be too large, ' +
        'or the parameters may send the Monte-Carlo search into open space. ' +
        'Try ignoring hydrogens/solvent residues or providing an explicit CPOINT.',
      )
    }
    throw e
  }

  // hole.f prints " HOLE: normal completion" on EVERY exit path (including
  // fatal errors), so a zero return code does NOT imply a pore was found.
  // parseHoleStdout + the checks below look at the actual content.
  const combinedLog = out + (err ? '\n' + err : '')
  writeFileSync(path.join(workDir, 'hole_out.txt'), combinedLog)
  if (rc !== 0 && !out.includes('normal completion')) {
    return {
      job_id: jobId,
      work_dir: workDir,
      profile: emptyProfile(),
      spheres: [],
      surface: { triangles: [], colors: [] },
      summary: { status: 'error', returncode: rc, stderr: err.slice(-2000) },
      files: listFiles(workDir),
      log_tail: out.slice(-3000),
      returncode: rc,
      error: err.slice(-1500) || 'HOLE failed',
      warnings: [],
      centreline: [],
    }
  }

  const profile = parseHoleStdout(out)
  const errorLines = (out.match(ERROR_LINES) || []).map((l) => l.trim()).slice(0, 10)
  const mDir = out.match(BEST_DIRECTION)
  const cguessDirection = mDir
    ? ({ '1': 'X', '2': 'Y', '3': 'Z' } as Record<string, string>)[mDir[1]] ?? null
    : null

  // -- "no pore traced" failure mode ---------------------------------------
  // HOLE can exit cleanly (rc=0, "normal completion") yet fail to trace any
  // pore: 0 profile samples + the 99999 sentinel minimum radius.  Surface an
  // actionable error instead of silently returning an empty profile.
  if (profile.n_samples === 0) {
    const hints: string[] = [
      'HOLE completed but could not trace a pore with the current parameters.',
    ]
    if (errorLines.length > 0) {
      hints.splice(1, 0, 'HOLE reported: ' + errorLines.slice(0, 3).join('; '))
    } else if (cguessDirection) {
      hints.push(
        `The automatic guess (cguess) chose the channel direction ${cguessDirection} — ` +
        'verify this matches the real pore axis; for large multi-domain channels ' +
        'the guess is often wrong.',
      )
    }
    if (params.cpoint_x === null && params.cvect_x === null) {
      hints.push(
        'Try providing an explicit Channel vector (CVECT) and Channel centre point (CPOINT) — ' +
        "e.g. for a C4-symmetric tetramer the pore runs through the symmetry axis.",
      )
    }
    hints.push(
      `If the pore has a wide vestibule or central cavity, raise the end radius ` +
      `(currently ${params.endrad.toFixed(1)} Å) above the cavity radius (e.g. 20–25 Å) ` +
      `so the trace continues through it instead of stopping at the first wide point.`,
    )
    hints.push(
      'Also consider ignoring solvent/ligand residues (HOH TIP WAT ...) that may block the pore.',
    )
    const warnings =
      hints.length > 2 ? [hints.slice(0, 2).join(' '), ...hints.slice(2)] : hints
    return {
      job_id: jobId,
      work_dir: workDir,
      profile,
      spheres: [],
      surface: { triangles: [], colors: [] },
      summary: {
        status: 'no_pore',
        returncode: rc,
        cguess_direction: cguessDirection,
        min_radius: null,
        n_samples: 0,
      },
      files: listFiles(workDir),
      log_tail: out.slice(-3000),
      returncode: rc,
      error: 'HOLE could not trace a pore — see warnings for suggested fixes.',
      warnings,
      centreline: [],
    }
  }

  // 5. Run `sph_process` twice — once for the dot surface (.qpt) and once
  //    for the solid surface (.sos).
  const sphPath = path.join(workDir, `${sphpdbName}.sph`)
  const dotden = Math.max(5, Math.min(30, Math.trunc(params.dotden) || 15))
  const dotQpt = path.join(workDir, 'dotsurface.qpt')
  const solidSos = path.join(workDir, 'solid_surface.sos')

  // Dot surface (.qpt) — best-effort, ignore failures.
  try {
    runInEnv(
      [envBin('sph_process'), '-dotden', String(dotden), '-color', sphPath, dotQpt],
      { cwd: workDir, input: null, timeout: 120_000 },
    )
  } catch { /* ignore — dot surface is best-effort */ }

  // Solid surface (.sos).
  try {
    runInEnv(
      [envBin('sph_process'), '-sos', '-dotden', String(dotden), '-color', sphPath, solidSos],
      { cwd: workDir, input: null, timeout: 120_000 },
    )
  } catch { /* ignore — sos_triangle will fail later */ }

  // 6. sos_triangle → .vmd_plot.  sos_triangle reads the .sos file from
  //    STDIN and writes VMD `draw trinorm`/`draw triangle` commands to STDOUT.
  //    It can fail on large pores with "Maximum number of polygons exceeded" —
  //    in that case we automatically retry with dotden=5 and faceted mode.
  const vmdPath = path.join(workDir, 'solid_surface.vmd_plot')
  const smooth = params.smooth_surface !== false
  let sosWarning: string | null = null

  const trySosTriangle = (
    sosContent: Buffer,
    useSmooth: boolean,
  ): { drawLines: string[]; stderr: string; returncode: number } => {
    const cmd = [envBin('sos_triangle')]
    if (useSmooth) cmd.push('-s')
    const env = { ...process.env }
    env.PATH = `${VENDOR_BIN}${path.delimiter}${env.PATH ?? ''}`
    env.LD_LIBRARY_PATH = `${path.join(VENDOR_HOLE2, 'lib')}${path.delimiter}${env.LD_LIBRARY_PATH ?? ''}`
    try {
      const result = spawnSync(cmd[0], cmd.slice(1), {
        cwd: workDir,
        input: sosContent,
        env,
        timeout: 180_000,
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf-8' as const,
      })
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      const drawLines = stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('draw '))
      return { drawLines, stderr, returncode: result.status ?? -1 }
    } catch (e) {
      return { drawLines: [], stderr: (e as Error).message, returncode: -1 }
    }
  }

  try {
    if (existsSync(solidSos) && statSync(solidSos).size > 0) {
      const sosContent = readFileSync(solidSos)
      // First attempt with the user-requested settings.
      const first = trySosTriangle(sosContent, smooth)
      let drawLines = first.drawLines
      let stderr = first.stderr
      if (drawLines.length === 0 && stderr.includes('Maximum number of polygons exceeded')) {
        // Auto-fallback: regenerate .sos with dotden=5 (minimum density) and
        // try again with faceted (non-smooth) mode.  This handles large pores
        // like the cholera-toxin pentamer.  Keep the original .sos as
        // .sos.full for download.
        try {
          if (existsSync(solidSos)) copyFileSync(solidSos, path.join(workDir, 'solid_surface.sos.full'))
          runInEnv(
            [envBin('sph_process'), '-sos', '-dotden', '5', '-color', sphPath, solidSos],
            { cwd: workDir, input: null, timeout: 120_000 },
          )
          if (existsSync(solidSos) && statSync(solidSos).size > 0) {
            const sos2 = readFileSync(solidSos)
            const retry = trySosTriangle(sos2, false)
            drawLines = retry.drawLines
            stderr = retry.stderr
            if (drawLines.length > 0) {
              sosWarning =
                'sos_triangle exceeded its polygon limit with the requested settings — ' +
                'used auto-fallback (dotden=5, faceted surface) to generate the 3D mesh. ' +
                'The full-density .sos is also available as solid_surface.sos.full.'
            }
          }
        } catch { /* ignore — fall through to the empty-output branch */ }
      }

      if (drawLines.length > 0) {
        writeFileSync(vmdPath, drawLines.join('\n') + '\n')
      } else if (stderr.includes('Maximum number of polygons exceeded')) {
        sosWarning =
          'sos_triangle exceeded its polygon limit on this large pore, even with the ' +
          'auto-fallback (dotden=5, faceted). The .sos intermediate file is still available ' +
          'for download — try a smaller endrad locally. The 3D surface will not be shown.'
      } else {
        sosWarning = `sos_triangle produced no output. stderr: ${stderr.slice(-300)}`
      }
    }
  } catch (e) {
    sosWarning = `sos_triangle failed: ${(e as Error).message}`
  }

  // 7. qpt_conv → dotsurface.vmd_plot.  Best-effort — the bundled vendor
  //    build hangs on the prompt feed (conda-forge exits cleanly), so the
  //    timeout is kept SHORT (5 s); a working qpt_conv finishes in <1 s.
  const dotVmdPath = path.join(workDir, 'dotsurface.vmd_plot')
  try {
    if (existsSync(dotQpt)) {
      const feed = Buffer.from('D\ndotsurface.qpt\ndotsurface.vmd_plot\n1\n')
      const env = { ...process.env }
      env.PATH = `${VENDOR_BIN}${path.delimiter}${env.PATH ?? ''}`
      env.LD_LIBRARY_PATH = `${path.join(VENDOR_HOLE2, 'lib')}${path.delimiter}${env.LD_LIBRARY_PATH ?? ''}`
      const r = spawnSync(envBin('qpt_conv'), {
        cwd: workDir,
        input: feed,
        env,
        timeout: 5_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf-8' as const,
      })
      // qpt_conv is supposed to write the output file; if it didn't, capture
      // its stdout as a fallback (some builds print the vmd commands instead).
      if (!existsSync(dotVmdPath) && r.stdout) {
        const keep = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('draw '))
        if (keep.length > 0) writeFileSync(dotVmdPath, keep.join('\n') + '\n')
      }
    }
  } catch { /* best-effort — ignore */ }

  // 8. Parse the structured data we need for the UI.
  const allSpheres = parseSphFile(sphPath)
  const surface = parseSosVmd(vmdPath)
  const clSpheres = centreLineSpheres(allSpheres)

  // 9. Infer cvec/cpoint via PCA if HOLE masked them with `****************`.
  if (profile.cvec === null || profile.cpoint === null) {
    const [inferredCvec, inferredCpoint] = inferChannelAxis(clSpheres)
    if (profile.cvec === null) profile.cvec = inferredCvec
    if (profile.cpoint === null) profile.cpoint = inferredCpoint
  }

  // 10. Sort centre-line spheres by their projection onto cvec so the
  //     centre-line tube in the 3D viewer runs smoothly along the pore.
  const [cvx, cvy, cvz] = profile.cvec ?? [0, 0, 1]
  const [cpx, cpy, cpz] = profile.cpoint ?? [0, 0, 0]
  const clSorted = [...clSpheres].sort((a, b) => {
    const pa = (a.x - cpx) * cvx + (a.y - cpy) * cvy + (a.z - cpz) * cvz
    const pb = (b.x - cpx) * cvx + (b.y - cpy) * cvy + (b.z - cpz) * cvz
    return pa - pb
  })

  // 11. Build the summary card.
  const summary: Record<string, unknown> = {
    status: 'ok',
    min_radius: profile.min_radius,
    min_t: profile.min_t,
    max_radius: profile.max_radius,
    pore_length: profile.pore_length,
    n_samples: profile.n_samples,
    g_factor: profile.g_factor,
    g_macro: profile.g_macro,
    n_spheres: allSpheres.length,
    n_triangles: surface.triangles.length,
    cguess_direction: cguessDirection,
  }
  if (allSpheres.length > 5000 || surface.triangles.length > 20000) {
    sosWarning = (sosWarning ? sosWarning + ' ' : '') +
      'Large result: the sphere/triangle payload sent to the 3D viewer ' +
      'was capped (5000 spheres / 20000 triangles); download the raw ' +
      'files for the full data.'
  }

  return {
    job_id: jobId,
    work_dir: workDir,
    profile,
    spheres: allSpheres,
    surface,
    summary,
    files: listFiles(workDir),
    log_tail: out.slice(-3000),
    returncode: 0,
    error: null,
    warnings: sosWarning ? [sosWarning] : [],
    centreline: clSorted.slice(0, 5000).map((s) => [s.x, s.y, s.z] as [number, number, number]),
  }
}

// ---------------------------------------------------------------------------
// Helpers — examples, rad-sets, downloads, ZIP
// ---------------------------------------------------------------------------

const EXAMPLE_DESCRIPTIONS: Record<string, string> = {
  '01_gramicidin_1grm':
    'Gramicidin A (1GRM) — narrow channel, single-file water wire. The classic HOLE demo.',
  '02_choleratoxin_1chb':
    'Cholera toxin B pentamer (1CHB) — large pore, uses the Connolly probe.',
  '03_maltoporin_1af6':
    'Maltoporin trimer (1AF6) — sugar channel with explicit CPOINT/CVECT overrides.',
  '04_trpm8_9pb6':
    'Avian TRPM8 tetramer (9PB6, menthol-bound cryo-EM) — large multi-domain channel whose ~19 Å central ' +
    'cavity defeats the default endrad=5 and the cguess auto-direction; runs with explicit CVECT 0 0 1, ' +
    'CPOINT and endrad 22.',
}

const EXAMPLE_PARAMS: Record<string, Record<string, string | boolean>> = {
  '01_gramicidin_1grm': {
    endrad: '5.0', ignore_residues: '', shorto: '0', dotden: '15',
  },
  '02_choleratoxin_1chb': {
    connolly: true, ignore_residues: 'HOH TIP WAT', shorto: '0', dotden: '5',
  },
  '03_maltoporin_1af6': {
    cvect_x: '0.0', cvect_y: '0.0', cvect_z: '1.0',
    cpoint_x: '-14.285', cpoint_y: '47.809', cpoint_z: '82.707',
    ignore_residues: 'FRU GLC MG HOH', shorto: '0', dotden: '15',
  },
  // TRPM8 9PB6: the pore runs along the C4 symmetry axis (z) through the
  // tetramer centre; endrad must exceed the ~19 Å central cavity so HOLE
  // does not treat the cavity as an immediate pore "end".
  '04_trpm8_9pb6': {
    cvect_x: '0.0', cvect_y: '0.0', cvect_z: '1.0',
    cpoint_x: '209.639', cpoint_y: '209.636', cpoint_z: '202.5',
    endrad: '22.0', ignore_residues: '', shorto: '0', dotden: '15',
  },
}

export interface ExampleInfo {
  id: string
  name: string
  pdb_files: string[]
  inp_files: string[]
  description: string
  params: Record<string, string | boolean>
}

/** Return all example directories (repo-local examples first, then vendor). */
export function exampleDirs(): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const root of [LOCAL_EXAMPLES, VENDOR_EXAMPLES]) {
    if (!existsSync(root)) continue
    let entries: string[] = []
    try { entries = readdirSync(root) } catch { continue }
    for (const name of entries.sort()) {
      if (name.startsWith('000') || seen.has(name)) continue
      const full = path.join(root, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch { continue }
      seen.add(name)
      dirs.push(full)
    }
  }
  return dirs
}

/** List bundled example structures + their recommended parameters. */
export function listExamples(): ExampleInfo[] {
  const out: ExampleInfo[] = []
  for (const d of exampleDirs()) {
    const name = path.basename(d)
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { continue }
    const pdbFiles = entries.filter((f) => f.endsWith('.pdb')).sort()
    const inpFiles = entries.filter((f) => f.endsWith('.inp')).sort()
    out.push({
      id: name,
      name,
      pdb_files: pdbFiles,
      inp_files: inpFiles,
      description: EXAMPLE_DESCRIPTIONS[name] ?? '',
      params: EXAMPLE_PARAMS[name] ?? {},
    })
  }
  return out
}

/** Resolve an example PDB file path safely (no path traversal). */
export function resolveExamplePdb(exampleId: string, pdbName: string): string | null {
  if (!SAFE_NAME_RE.test(exampleId) || !SAFE_NAME_RE.test(pdbName)) return null
  for (const root of [LOCAL_EXAMPLES, VENDOR_EXAMPLES]) {
    if (!existsSync(root)) continue
    const direct = path.join(root, exampleId, pdbName)
    if (existsSync(direct) && statSync(direct).isFile()) {
      // Verify the resolved path is still inside root.
      if (path.relative(root, direct).startsWith('..')) return null
      return direct
    }
    // Prefix-match fallback (e.g. user passes "1grm_single" but file is "1grm_single.pdb").
    const dir = path.join(root, exampleId)
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      try {
        for (const candidate of readdirSync(dir)) {
          if (candidate.startsWith(pdbName) && statSync(path.join(dir, candidate)).isFile()) {
            const full = path.join(dir, candidate)
            if (path.relative(root, full).startsWith('..')) return null
            return full
          }
        }
      } catch { /* ignore */ }
    }
  }
  return null
}

const RAD_DESCRIPTIONS: Record<string, string> = {
  simple:
    'Simple AMBER vdw radii — one value per element (C 1.85, O 1.65, N 1.75, etc.). Recommended for most protein channels. From Weiner et al. 1984 JACS.',
  amberuni:
    'AMBER united-atom radii — treats hydrogens implicitly (merged into heavy atoms). Use for structures without explicit hydrogens. Faster, slightly different radii than simple.rad.',
  bondi:
    'Bondi radii — widely-used compilation (Bondi 1964). Slightly larger vdW for polar atoms. Good for structures with explicit hydrogens.',
  hardcore:
    'Hard-sphere radii — smaller vdW (close-packed). Produces narrower pores. Use to test sensitivity to the radius set.',
  xplor:
    'X-PLOR/CNS radii — matches the X-PLOR simulation package conventions. Use if your structure came from X-PLOR/CNS.',
}

/** List bundled vdw radius sets with descriptions. */
export function listRadSets(): { rad_sets: { name: string; description: string }[]; default: string } {
  const names: string[] = []
  if (existsSync(VENDOR_RAD)) {
    try {
      for (const f of readdirSync(VENDOR_RAD)) {
        if (f.endsWith('.rad')) names.push(f.replace(/\.rad$/, ''))
      }
    } catch { /* ignore */ }
  }
  return {
    rad_sets: names.sort().map((n) => ({
      name: n,
      description: RAD_DESCRIPTIONS[n] ?? 'HOLE2 vdw radius set',
    })),
    default: 'simple',
  }
}

/** Allowed radius-set names (for validation). */
export function allowedRadSets(): Set<string> {
  const s = new Set<string>()
  if (existsSync(VENDOR_RAD)) {
    try {
      for (const f of readdirSync(VENDOR_RAD)) {
        if (f.endsWith('.rad')) s.add(f.replace(/\.rad$/, ''))
      }
    } catch { /* ignore */ }
  }
  return s
}

/** Validate a job_id (12 hex chars). */
export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId)
}

/** Validate a filename (no path traversal). */
export function isSafeFilename(name: string): boolean {
  return SAFE_NAME_RE.test(name)
}

/** Validate an example_id / pdb_name. */
export function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name)
}

/** Validate an ignore_residues string (space-separated residue names). */
export function isValidIgnoreList(s: string): boolean {
  return IGNORE_RE.test(s)
}

/** List the files (name + size) in a job directory. */
export function listJobFiles(jobId: string): { name: string; size: number }[] {
  if (!isValidJobId(jobId)) return []
  const jobDir = path.join(JOBS_DIR, jobId)
  if (!existsSync(jobDir) || !statSync(jobDir).isDirectory()) return []
  const out: { name: string; size: number }[] = []
  try {
    for (const f of readdirSync(jobDir)) {
      const full = path.join(jobDir, f)
      const st = statSync(full)
      if (st.isFile()) out.push({ name: f, size: st.size })
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a job file path safely (no path traversal). */
export function resolveJobFile(jobId: string, filename: string): string | null {
  if (!isValidJobId(jobId) || !isSafeFilename(filename)) return null
  const jobDir = path.join(JOBS_DIR, jobId)
  if (!existsSync(jobDir) || !statSync(jobDir).isDirectory()) return null
  const target = path.join(jobDir, filename)
  if (path.relative(jobDir, target).startsWith('..')) return null
  if (!existsSync(target) || !statSync(target).isFile()) return null
  return target
}

/** Return the path to a job directory (or null if invalid). */
export function jobDirPath(jobId: string): string | null {
  if (!isValidJobId(jobId)) return null
  const p = path.join(JOBS_DIR, jobId)
  if (!existsSync(p) || !statSync(p).isDirectory()) return null
  return p
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyProfile(): PoreProfile {
  return {
    cvec: null, cpoint: null, samples: [],
    min_radius: null, min_t: null, max_radius: null,
    n_samples: 0, g_factor: null, g_macro: null, pore_length: null,
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Job directory sweeper — runs in a setInterval on first import.
// Each job can hold a 50 MB PDB + outputs, so we delete dirs older than 24 h.
// ---------------------------------------------------------------------------

const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const JOB_SWEEP_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

declare global {
  var __hole2SweeperStarted: boolean | undefined
}

/** Recursively delete a directory's contents then the directory itself. */
function removeDirRecursive(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f)
      const st = statSync(full)
      if (st.isDirectory()) removeDirRecursive(full)
      else unlinkSync(full)
    }
    rmdirSync(dir)
  } catch { /* ignore */ }
}

/** Start the job-dir sweeper exactly once per server process. */
export function ensureSweeperStarted(): void {
  if (global.__hole2SweeperStarted) return
  global.__hole2SweeperStarted = true
  const sweep = () => {
    try {
      if (!existsSync(JOBS_DIR)) return
      const now = Date.now()
      for (const d of readdirSync(JOBS_DIR)) {
        try {
          const full = path.join(JOBS_DIR, d)
          const st = statSync(full)
          if (st.isDirectory() && now - st.mtimeMs > JOB_MAX_AGE_MS) {
            removeDirRecursive(full)
          }
        } catch { /* ignore */ }
      }
    } catch { /* sweeper must never crash */ }
  }
  sweep() // run once at startup
  const handle = setInterval(sweep, JOB_SWEEP_INTERVAL_MS)
  // Don't keep the Node event loop alive just for the sweeper.
  if (handle && typeof handle.unref === 'function') handle.unref()
}
