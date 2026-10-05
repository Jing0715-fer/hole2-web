/**
 * GET /api/examples
 *
 * List the bundled example structures (gramicidin, cholera toxin,
 * maltoporin, TRPM8) together with their recommended parameters.
 */

import { NextResponse } from 'next/server'
import { listExamples } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const examples = listExamples()
  return NextResponse.json({ examples })
}
