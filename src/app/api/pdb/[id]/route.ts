/**
 * GET /api/pdb/[id]
 *
 * Fetch a structure from the RCSB PDB by its 4-character ID.
 *
 * Proxies the request server-side to avoid CORS restrictions in the browser.
 * Tries the .pdb format first (HOLE2's preferred input), then .cif as a
 * fallback. The download is capped at 50 MB so a huge cryo-EM structure does
 * not stall the request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { MAX_UPLOAD_BYTES } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await ctx.params
  const pid = (rawId || '').trim().toLowerCase()
  if (!/^[0-9a-z]{4}$/.test(pid)) {
    return NextResponse.json(
      { detail: 'PDB ID must be exactly 4 alphanumeric characters' },
      { status: 400 },
    )
  }

  const urls: [string, 'pdb' | 'cif'][] = [
    [`https://files.rcsb.org/download/${pid}.pdb`, 'pdb'],
    [`https://files.rcsb.org/download/${pid}.cif`, 'cif'],
  ]
  let lastErr = ''
  for (const [url, fmt] of urls) {
    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'hole2-web/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!upstream.ok) {
        lastErr = `HTTP ${upstream.status} from RCSB`
        continue
      }
      const buf = await upstream.arrayBuffer()
      const content = Buffer.from(buf)
      if (content.length > MAX_UPLOAD_BYTES) {
        lastErr =
          `structure ${pid} exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB ` +
          'download cap — download it from RCSB and upload the file instead'
        continue
      }
      if (content.length < 100) {
        lastErr = `Empty response from ${url}`
        continue
      }
      return NextResponse.json({
        pdb_id: pid,
        format: fmt,
        filename: `${pid}.${fmt}`,
        content: content.toString('utf-8'),
        size: content.length,
      })
    } catch (e) {
      lastErr = (e as Error).message
    }
  }
  return NextResponse.json(
    { detail: `PDB ID '${pid}' not found at RCSB. ${lastErr}` },
    { status: 404 },
  )
}
