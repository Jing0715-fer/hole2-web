/**
 * CAVER API client — fetch wrappers for /api/caver/*
 */

import { DEFAULT_CAVER_PARAMS, type CaverParams, type CaverResult } from './types'

/** Run CAVER analysis on the given PDB file + parameters. */
export async function runCaverAnalysis(
  pdbFile: File,
  pdbName: string,
  params: CaverParams,
): Promise<CaverResult> {
  const formData = new FormData()
  formData.append('pdb', pdbFile)
  formData.append('pdb_name', pdbName)
  formData.append('params', JSON.stringify(params))

  const res = await fetch('/api/caver/run', {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg = body.error ?? msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json()
}

/** Build a download URL for a CAVER output file. */
export function caverFileUrl(jobId: string, filePath: string): string {
  return `/api/caver/job/${jobId}/files?path=${encodeURIComponent(filePath)}`
}

/** Check if Java is available on the server. */
export async function checkCaverReady(): Promise<boolean> {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    // CAVER needs Java (JRE) — we piggyback on the same health endpoint
    // that reports env_ready for HOLE2.  If the server is up, Java is
    // available (it's checked at server start).
    return data.env_ready === true
  } catch {
    return false
  }
}

export { DEFAULT_CAVER_PARAMS }
export type { CaverParams, CaverResult }
