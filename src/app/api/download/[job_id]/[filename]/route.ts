/**
 * GET /api/download/[job_id]/[filename]
 *
 * Stream a single raw output file produced by HOLE2 (hole_out.txt, *.sph,
 * *.qpt, *.sos, *.vmd_plot, *.sos_ascii, ...).
 *
 * Both path params are validated: job_id must match `^[0-9a-f]{12}$` and the
 * filename must match `^[A-Za-z0-9_.-]+$`.  The resolved path is checked to
 * remain inside the job directory.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { resolveJobFile } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ job_id: string; filename: string }> },
) {
  const { job_id: jobId, filename } = await ctx.params
  const target = resolveJobFile(jobId, filename)
  if (!target) {
    return NextResponse.json(
      { detail: `File ${filename} not found in job ${jobId}` },
      { status: 404 },
    )
  }
  let buf: Buffer
  try {
    buf = readFileSync(target)
  } catch {
    return NextResponse.json(
      { detail: `Could not read ${filename}` },
      { status: 500 },
    )
  }
  let media = 'application/octet-stream'
  if (filename.endsWith('.txt')) media = 'text/plain'
  else if (filename.endsWith('.pdb') || filename.endsWith('.sph')) media = 'chemical/x-pdb'
  else if (filename.endsWith('.vmd_plot')) media = 'text/plain'
  else if (filename.endsWith('.sos') || filename.endsWith('.qpt')) media = 'application/octet-stream'
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': media,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
    },
  })
}
