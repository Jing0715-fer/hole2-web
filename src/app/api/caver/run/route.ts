/**
 * POST /api/caver/run
 * -------------------
 * Accepts a PDB/CIF file + CAVER parameters, runs caver.jar, and returns
 * the parsed tunnel data + cluster summaries as JSON.
 *
 * Form-data fields:
 *   - pdb: File (PDB or mmCIF text)
 *   - pdb_name: string (filename, e.g. "1grm.pdb")
 *   - params: JSON-encoded CaverParams
 */

import { NextRequest, NextResponse } from 'next/server'
import { runCaver } from '@/lib/caver/caver-runner'
import { DEFAULT_CAVER_PARAMS, type CaverParams } from '@/lib/caver/types'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('pdb')
    const pdbName = (formData.get('pdb_name') as string) || 'input.pdb'
    const paramsJson = formData.get('params') as string | null

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'No PDB file provided' },
        { status: 400 },
      )
    }

    // Merge user params with defaults
    let params: CaverParams = { ...DEFAULT_CAVER_PARAMS }
    if (paramsJson) {
      try {
        const userParams = JSON.parse(paramsJson) as Partial<CaverParams>
        params = { ...params, ...userParams }
      } catch {
        return NextResponse.json(
          { error: 'Invalid params JSON' },
          { status: 400 },
        )
      }
    }

    const pdbText = await file.text()
    if (!pdbText || pdbText.length < 100) {
      return NextResponse.json(
        { error: 'PDB file appears to be empty or too small' },
        { status: 400 },
      )
    }

    const result = await runCaver(pdbText, pdbName, params)
    return NextResponse.json(result)
  } catch (e) {
    const msg = (e as Error).message
    console.error('CAVER run error:', msg)
    return NextResponse.json(
      { error: `CAVER analysis failed: ${msg}` },
      { status: 500 },
    )
  }
}
