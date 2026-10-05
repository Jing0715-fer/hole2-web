/**
 * GET /api/rad-sets
 *
 * List the bundled vdw radius set files (vendor/hole2/rad/*.rad) with
 * human-readable descriptions to help the user pick one.
 */

import { NextResponse } from 'next/server'
import { listRadSets } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listRadSets())
}
