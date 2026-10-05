import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy API route — forwards requests to the Python HOLE2 service on port 3001.
 * Used when the browser can't reach port 3001 directly (CORS, firewall)
 * and there's no Caddy gateway with XTransformPort support.
 *
 * Any request to /api/hole/* is proxied to http://localhost:3001/api/*
 */

const SERVICE_URL = 'http://localhost:3001'

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const search = req.nextUrl.search || ''
  const url = `${SERVICE_URL}/api/${path.join('/')}${search}`
  try {
    const r = await fetch(url)
    const data = await r.text()
    return new NextResponse(data, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json' }
    })
  } catch (e) {
    return NextResponse.json({ error: 'HOLE2 service unavailable', detail: String(e) }, { status: 503 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const search = req.nextUrl.search || ''
  const url = `${SERVICE_URL}/api/${path.join('/')}${search}`
  try {
    const body = await req.formData()
    const r = await fetch(url, { method: 'POST', body })
    const data = await r.text()
    return new NextResponse(data, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json' }
    })
  } catch (e) {
    return NextResponse.json({ error: 'HOLE2 service unavailable', detail: String(e) }, { status: 503 })
  }
}
