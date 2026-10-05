/**
 * Front-end API client for the HOLE2 Python mini-service.
 *
 * All requests go through the Next.js route handler at /api/hole/* which
 * proxies them to the Python service on 127.0.0.1:3001 (and auto-starts
 * it if it is not running). This works from any origin without CORS or
 * gateway port-forwarding.
 */

import type { RunParams, RunResult } from './types'

function apiUrl(path: string) {
  // Path looks like "/api/health" -> "/api/hole/health" (proxied by Next.js)
  return path.replace(/^\/api\//, '/api/hole/')
}

export interface RadSetInfo {
  rad_sets: { name: string; description: string }[]
  default: string
}

export interface PdbFetchResult {
  pdb_id: string
  format: 'pdb' | 'cif'
  filename: string
  content: string
  size: number
}

export interface ExampleInfo {
  id: string
  name: string
  pdb_files: string[]
  inp_files: string[]
  description: string
}

export async function fetchHealth(): Promise<{ status: string; env_ready: boolean }> {
  const r = await fetch(apiUrl('/api/health'))
  if (!r.ok) throw new Error(`health: ${r.status}`)
  return r.json()
}

export async function fetchRadSets(): Promise<RadSetInfo> {
  const r = await fetch(apiUrl('/api/rad-sets'))
  if (!r.ok) throw new Error(`rad-sets: ${r.status}`)
  return r.json()
}

export async function fetchExamples(): Promise<ExampleInfo[]> {
  const r = await fetch(apiUrl('/api/examples'))
  if (!r.ok) throw new Error(`examples: ${r.status}`)
  const d = await r.json()
  return d.examples ?? []
}

/** Build the URL for fetching an example PDB file (so the front-end can
 *  one-click load the gramicidin / cholera-toxin / maltoporin demos). */
export function examplePdbUrl(exampleId: string, pdbName: string): string {
  return apiUrl(`/api/example/${encodeURIComponent(exampleId)}/${encodeURIComponent(pdbName)}`)
}

/** Fetch a structure from RCSB by its 4-character PDB ID (e.g. "1grm").
 *  Returns the raw PDB or mmCIF text.  Proxied through the Python service
 *  to avoid CORS restrictions in the browser. */
export async function fetchPdbId(pdbId: string): Promise<PdbFetchResult> {
  const pid = pdbId.trim().toLowerCase()
  if (!/^[a-z0-9]{4}$/.test(pid)) {
    throw new Error('PDB ID must be exactly 4 alphanumeric characters (e.g. 1grm)')
  }
  const r = await fetch(apiUrl(`/api/pdb/${encodeURIComponent(pid)}`))
  if (!r.ok) {
    let msg = `RCSB fetch failed: HTTP ${r.status}`
    try {
      const d = await r.json()
      if (d?.detail) msg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail)
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return r.json()
}

/** Build the URL for downloading a raw output file. */
export function downloadUrl(jobId: string, filename: string): string {
  return apiUrl(`/api/download/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`)
}

/** Build the URL for downloading all output files as a ZIP archive. */
export function downloadZipUrl(jobId: string): string {
  return apiUrl(`/api/job/${encodeURIComponent(jobId)}/zip`)
}

export interface JobFile { name: string; size: number }

export async function fetchJobFiles(jobId: string): Promise<JobFile[]> {
  const r = await fetch(apiUrl(`/api/job/${encodeURIComponent(jobId)}/files`))
  if (!r.ok) throw new Error(`job files: ${r.status}`)
  const d = await r.json()
  return d.files ?? []
}

/** Run HOLE2 on an uploaded PDB file with the given parameters. */
export async function runHole(
  pdbFile: File | Blob,
  pdbName: string,
  params: RunParams,
  customRad?: File | null,
): Promise<RunResult> {
  const form = new FormData()
  form.append('pdb_file', pdbFile, pdbName)
  if (customRad) form.append('radius_file', customRad, customRad.name)
  form.append('radius_set', params.radius_set)
  form.append('cpoint_x', params.cpoint_x || '')
  form.append('cpoint_y', params.cpoint_y || '')
  form.append('cpoint_z', params.cpoint_z || '')
  form.append('cvect_x', params.cvect_x || '')
  form.append('cvect_y', params.cvect_y || '')
  form.append('cvect_z', params.cvect_z || '')
  form.append('endrad', params.endrad || '5.0')
  form.append('shorto', params.shorto || '0')
  form.append('connolly', params.connolly ? 'true' : 'false')
  form.append('ignore_residues', params.ignore_residues || '')
  form.append('sphpdb_name', params.sphpdb_name || 'hole_out')
  form.append('dotden', params.dotden || '15')
  form.append('smooth_surface', params.smooth_surface ? 'true' : 'false')

  const r = await fetch(apiUrl('/api/run'), { method: 'POST', body: form })
  if (!r.ok) {
    let msg = `HOLE2 run failed: HTTP ${r.status}`
    try {
      const d = await r.json()
      if (d?.detail) msg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail)
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return r.json()
}

/** Human-readable descriptions for each HOLE2 output file. */
export const FILE_DESCRIPTIONS: Record<string, string> = {
  'hole_out.txt': 'HOLE text log + per-sample profile (the main output)',
  'hole_out.sph': 'Sphere centres in pseudo-PDB format (B-factor = radius)',
  'dotsurface.qpt': 'Binary dot-surface file (Hydra/Quanta plot format)',
  'solid_surface.sos': 'Intermediate solid-surface file (input to sos_triangle)',
  'solid_surface.vmd_plot': 'VMD "draw trinorm" commands for the solid surface',
  'dotsurface.vmd_plot': 'VMD "draw" commands for the dot surface',
  'hole.inp': 'The HOLE input file used for this run',
  'simple.rad': 'Van der Waals radii set used for this run',
}

export function describeFile(name: string): string {
  return FILE_DESCRIPTIONS[name]
    ?? (name.endsWith('.pdb') ? 'Input PDB coordinate file'
        : name.endsWith('.rad') ? 'Van der Waals radii set'
        : 'HOLE2 output file')
}
