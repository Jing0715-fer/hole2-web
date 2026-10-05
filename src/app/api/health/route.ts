/**
 * GET /api/health
 *
 * Liveness probe — reports whether the bundled HOLE2 binaries
 * (vendor/hole2/bin/) are present and executable, and where jobs are stored.
 */

import { NextResponse } from 'next/server'
import { envExists, JOBS_DIR, envBin, ensureSweeperStarted } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  ensureSweeperStarted()
  return NextResponse.json({
    status: 'ok',
    env_ready: envExists(),
    env_prefix: envExists() ? 'vendor/hole2' : null,
    hole_bin: envBin('hole'),
    jobs_dir: JOBS_DIR,
  })
}
