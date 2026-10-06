/**
 * GET /api/caver/job/[job_id]/files?path=<relative/path>
 *
 * Stream a single raw output file produced by CAVER (log.txt, tunnels .obj,
 * tree_.txt, etc.).  The `path` query param is validated to prevent path
 * traversal (must remain inside the job directory).
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join, normalize, relative } from 'path'
import { getCaverJobDir } from '@/lib/caver/caver-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ job_id: string }> },
) {
  const { job_id: jobId } = await ctx.params
  const url = new URL(req.url)
  const fileParam = url.searchParams.get('path')
  if (!fileParam) {
    return NextResponse.json({ detail: 'Missing `path` query parameter' }, { status: 400 })
  }

  const jobDir = getCaverJobDir(jobId)
  if (!existsSync(jobDir)) {
    return NextResponse.json({ detail: `Job ${jobId} not found` }, { status: 404 })
  }

  // Resolve the requested path and ensure it stays inside the job dir
  const requested = normalize(fileParam).replace(/^(\.\.[/\\])+/, '')
  const fullPath = join(jobDir, requested)
  const rel = relative(jobDir, fullPath)
  if (rel.startsWith('..') || rel.includes('..')) {
    return NextResponse.json({ detail: 'Path traversal blocked' }, { status: 403 })
  }

  if (!existsSync(fullPath)) {
    return NextResponse.json({ detail: `File not found: ${fileParam}` }, { status: 404 })
  }

  let buf: Buffer
  try {
    buf = readFileSync(fullPath)
  } catch {
    return NextResponse.json({ detail: `Could not read: ${fileParam}` }, { status: 500 })
  }

  const filename = fileParam.split('/').pop() || 'download'
  let media = 'application/octet-stream'
  if (filename.endsWith('.txt')) media = 'text/plain'
  else if (filename.endsWith('.pdb')) media = 'chemical/x-pdb'
  else if (filename.endsWith('.dat')) media = 'application/octet-stream'
  else if (filename.endsWith('.obj')) media = 'application/octet-stream'

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': media,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
    },
  })
}
