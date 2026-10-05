/**
 * POST /api/run
 *
 * Run the full HOLE2 pipeline (hole + sph_process + sos_triangle) on an
 * uploaded PDB file with the given parameters.  Returns the parsed
 * pore-profile data + a list of downloadable output files.
 *
 * Multipart form fields:
 *   - pdb_file       (required) — PDB coordinate file
 *   - radius_file    (optional) — custom .rad file (defaults to simple.rad)
 *   - radius_set     (string)   — bundled rad set name (simple/amberuni/...)
 *   - cpoint_x/y/z   (float)    — channel centre point override
 *   - cvect_x/y/z    (float)    — channel vector override
 *   - endrad         (float)    — end radius in Å (default 5.0)
 *   - shorto         (int 0..3) — short output level (default 0)
 *   - connolly       (bool)     — use Connolly probe
 *   - ignore_residues(string)   — space-separated residue names to ignore
 *   - sphpdb_name    (string)   — output sphere PDB base name (default hole_out)
 *   - dotden         (int 5..30)— dot density for sph_process (default 15)
 *   - smooth_surface (bool)     — use sos_triangle -s (smooth) flag (default true)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  MAX_UPLOAD_BYTES, MAX_RAD_BYTES, MAX_CONCURRENT_RUNS,
  runHolePipeline, allowedRadSets,
  isSafeName, isValidIgnoreList,
  type RunParamsInternal, ensureSweeperStarted,
} from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min — HOLE runs can be slow on large structures

// ---------------------------------------------------------------------------
// Simple concurrency limiter — at most MAX_CONCURRENT_RUNS HOLE2 pipelines
// running at once (each run spawns up to 6 Fortran subprocesses and allocates
// large work arrays for big PDBs).
// ---------------------------------------------------------------------------

let activeRuns = 0
const waitQueue: Array<() => void> = []

async function acquireSlot(timeoutMs: number): Promise<boolean> {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns++
    return true
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(wake)
      if (idx >= 0) waitQueue.splice(idx, 1)
      resolve(false)
    }, timeoutMs)
    const wake = () => {
      clearTimeout(timer)
      activeRuns++
      resolve(true)
    }
    waitQueue.push(wake)
  })
}

function releaseSlot(): void {
  activeRuns--
  const next = waitQueue.shift()
  if (next) next()
}

// ---------------------------------------------------------------------------
// Form field helpers
// ---------------------------------------------------------------------------

function formStr(form: FormData, key: string): string | null {
  const v = form.get(key)
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : null
}

function formFloat(form: FormData, key: string): number | null {
  const v = formStr(form, key)
  if (v === null || v === '') return null
  const f = parseFloat(v)
  return Number.isNaN(f) ? null : f
}

function formInt(form: FormData, key: string, def: number): number {
  const v = formStr(form, key)
  if (v === null || v === '') return def
  const i = parseInt(v, 10)
  return Number.isNaN(i) ? def : i
}

function formBool(form: FormData, key: string, def: boolean): boolean {
  const v = formStr(form, key)
  if (v === null) return def
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  ensureSweeperStarted()

  // Hard-cap the request body size early via Content-Length (belt-and-braces
  // with the post-read cap below).
  const cl = req.headers.get('content-length')
  if (cl && /^\d+$/.test(cl)) {
    const total = parseInt(cl, 10)
    if (total > MAX_UPLOAD_BYTES + MAX_RAD_BYTES + 1024 * 1024) {
      return NextResponse.json(
        { detail: `Request body too large (> ${Math.floor((MAX_UPLOAD_BYTES + MAX_RAD_BYTES) / 1024 / 1024)} MB). Upload a smaller structure or strip solvent/hydrogens.` },
        { status: 413 },
      )
    }
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch (e) {
    return NextResponse.json(
      { detail: `Could not parse multipart form data: ${(e as Error).message}` },
      { status: 400 },
    )
  }

  // --- input validation --------------------------------------------------
  const sphpdbName = (formStr(form, 'sphpdb_name') || 'hole_out').trim() || 'hole_out'
  if (!isSafeName(sphpdbName)) {
    return NextResponse.json(
      { detail: 'sphpdb_name may only contain letters, digits, dot, dash, underscore' },
      { status: 400 },
    )
  }
  const ignoreResidues = (formStr(form, 'ignore_residues') || '').trim()
  if (ignoreResidues && !isValidIgnoreList(ignoreResidues)) {
    return NextResponse.json(
      { detail: 'ignore_residues may only contain letters, digits, spaces, dashes' },
      { status: 400 },
    )
  }

  const radiusSet = formStr(form, 'radius_set') || 'simple'
  const radiusFile = form.get('radius_file')
  const hasCustomRad =
    radiusFile !== null && typeof radiusFile !== 'string' && (radiusFile as File).name !== ''
  if (!hasCustomRad) {
    const allowed = allowedRadSets()
    if (allowed.size > 0 && !allowed.has(radiusSet)) {
      return NextResponse.json(
        { detail: `Unknown radius set '${radiusSet}'. Allowed: ${Array.from(allowed).sort().join(', ')}` },
        { status: 400 },
      )
    }
  }

  // --- read the PDB file -------------------------------------------------
  const pdbField = form.get('pdb_file')
  if (pdbField === null || typeof pdbField === 'string') {
    return NextResponse.json(
      { detail: 'pdb_file is required (multipart file upload)' },
      { status: 400 },
    )
  }
  const pdbFile = pdbField as File
  const pdbBytes = Buffer.from(await pdbFile.arrayBuffer())
  if (pdbBytes.length === 0) {
    return NextResponse.json({ detail: 'Empty PDB file' }, { status: 400 })
  }
  if (pdbBytes.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { detail: `PDB file too large (> ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)` },
      { status: 413 },
    )
  }

  // --- read the optional custom .rad file --------------------------------
  let customRad: Buffer | null = null
  if (hasCustomRad && radiusFile && typeof radiusFile !== 'string') {
    const radBuf = Buffer.from(await (radiusFile as File).arrayBuffer())
    if (radBuf.length > MAX_RAD_BYTES) {
      return NextResponse.json(
        { detail: `Radius file too large (> ${Math.floor(MAX_RAD_BYTES / 1024)} KB)` },
        { status: 413 },
      )
    }
    customRad = radBuf
  }

  // --- assemble the typed params object ----------------------------------
  const params: RunParamsInternal = {
    radius_set: radiusSet,
    cpoint_x: formFloat(form, 'cpoint_x'),
    cpoint_y: formFloat(form, 'cpoint_y'),
    cpoint_z: formFloat(form, 'cpoint_z'),
    cvect_x: formFloat(form, 'cvect_x'),
    cvect_y: formFloat(form, 'cvect_y'),
    cvect_z: formFloat(form, 'cvect_z'),
    endrad: formFloat(form, 'endrad') ?? 5.0,
    shorto: formInt(form, 'shorto', 0),
    connolly: formBool(form, 'connolly', false),
    ignore_residues: ignoreResidues,
    sphpdb_name: sphpdbName,
    dotden: Math.max(5, Math.min(30, formInt(form, 'dotden', 15))),
    smooth_surface: formBool(form, 'smooth_surface', true),
  }

  // --- acquire a concurrency slot ----------------------------------------
  const got = await acquireSlot(5_000)
  if (!got) {
    return NextResponse.json(
      { detail: 'Server busy — other HOLE2 runs are in progress. Try again shortly.' },
      { status: 429 },
    )
  }
  try {
    const result = runHolePipeline(pdbBytes, pdbFile.name || 'input.pdb', params, customRad)
    return NextResponse.json({
      job_id: result.job_id,
      profile: result.profile,
      summary: result.summary,
      spheres: result.spheres.slice(0, 5000), // cap for the JSON payload
      surface: {
        triangles: result.surface.triangles.slice(0, 20000),
        colors: result.surface.colors.slice(0, 20000),
      },
      centreline: result.centreline.slice(0, 5000),
      files: result.files,
      log_tail: result.log_tail,
      input_file: 'hole.inp',
      returncode: result.returncode,
      error: result.error,
      warnings: result.warnings,
    })
  } catch (e) {
    return NextResponse.json(
      { detail: (e as Error).message || 'HOLE2 run failed' },
      { status: 500 },
    )
  } finally {
    releaseSlot()
  }
}
