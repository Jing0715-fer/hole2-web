import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy API route — forwards ALL requests to the Python HOLE2 service on port 3001.
 * Any request to /api/hole/* is proxied to http://localhost:3001/api/*
 */

const SERVICE_URL = process.env.HOLE2_SERVICE_URL || 'http://localhost:3001'

async function proxy(req: NextRequest, pathParts: string[], method: string) {
  const search = req.nextUrl.search || ''
  const url = `${SERVICE_URL}/api/${pathParts.join('/')}${search}`

  try {
    const fetchOpts: RequestInit = { method }

    if (method === 'POST' || method === 'PUT') {
      // Convert the request body to a buffer (Node.js fetch doesn't accept ReadableStream directly)
      const bodyBuffer = await req.arrayBuffer()
      fetchOpts.body = bodyBuffer
      // Forward content-type header (important for multipart/form-data with boundary)
      const contentType = req.headers.get('content-type')
      if (contentType) {
        fetchOpts.headers = { 'Content-Type': contentType }
      }
    }

    const r = await fetch(url, fetchOpts)
    const data = await r.arrayBuffer()

    const headers: Record<string, string> = {
      'Content-Type': r.headers.get('Content-Type') || 'application/json',
    }
    const cd = r.headers.get('Content-Disposition')
    if (cd) headers['Content-Disposition'] = cd

    return new NextResponse(data, { status: r.status, headers })
  } catch (e) {
    return NextResponse.json(
      { error: 'HOLE2 service unavailable', detail: String(e) },
      { status: 503 }
    )
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  return proxy(req, path, 'GET')
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  return proxy(req, path, 'POST')
}
