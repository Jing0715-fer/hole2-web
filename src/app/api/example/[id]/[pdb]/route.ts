/**
 * GET /api/example/[id]/[pdb]
 *
 * Serve a bundled example PDB file (gramicidin / cholera-toxin / maltoporin /
 * TRPM8 demos) so the front-end can one-click load it.
 *
 * Both path parameters are validated against `[A-Za-z0-9_.-]+` and resolved
 * against the vendor/hole2/examples/ root — no path traversal possible.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { resolveExamplePdb, isSafeName } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; pdb: string }> },
) {
  const { id, pdb } = await ctx.params
  if (!isSafeName(id) || !isSafeName(pdb)) {
    return NextResponse.json({ detail: 'Invalid example id or file name' }, { status: 400 })
  }
  const p = resolveExamplePdb(id, pdb)
  if (!p) {
    return NextResponse.json({ detail: 'Example file not found' }, { status: 404 })
  }
  const buf = readFileSync(p)
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'chemical/x-pdb',
      'Content-Disposition': `attachment; filename="${pdb}"`,
    },
  })
}
