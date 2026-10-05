/**
 * GET /api/job/[job_id]/files
 *
 * List the raw output files (name + size) for a job, used by the download UI.
 */

import { NextRequest, NextResponse } from 'next/server'
import { listJobFiles, isValidJobId, jobDirPath } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ job_id: string }> },
) {
  const { job_id: jobId } = await ctx.params
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ detail: 'Invalid job_id' }, { status: 400 })
  }
  if (!jobDirPath(jobId)) {
    return NextResponse.json({ detail: 'Unknown job_id' }, { status: 404 })
  }
  return NextResponse.json({
    job_id: jobId,
    files: listJobFiles(jobId),
  })
}
