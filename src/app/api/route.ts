/**
 * GET /api
 *
 * Service index — lists all available HOLE2 API endpoints.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    service: 'hole2',
    endpoints: [
      'GET  /api/health',
      'GET  /api/rad-sets',
      'GET  /api/examples',
      'GET  /api/example/{id}/{pdb}',
      'GET  /api/pdb/{id}',
      'POST /api/run',
      'GET  /api/download/{job_id}/{filename}',
      'GET  /api/job/{job_id}/files',
      'GET  /api/job/{job_id}/zip',
    ],
  })
}
