import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy API route — forwards ALL requests to the Python HOLE2 service on port 3001.
 *
 * Any request to /api/hole/* is proxied to http://localhost:3001/api/*
 * This is the default connection mode for standalone deployments (no Caddy gateway).
 *
 * Supports GET, POST (including multipart/form-data file uploads), and HEAD.
 */

const SERVICE_URL = process.env.HOLE2_SERVICE_URL || 'http://localhost:3001'

async function proxy(req: NextRequest, pathParts: string[], method: string) {
  const search = req.nextUrl.search || ''
  const url = `${SERVICE_URL}/api/${pathParts.join('/')}${search}`

  try {
    // Build the fetch options
    const fetchOpts: RequestInit = { method }

    // Forward the body for POST/PUT requests
    if (method === 'POST' || method === 'PUT') {
      // Clone the request body as-is (handles FormData, JSON, etc.)
      fetchOpts.body = req.body
      // Forward content-type header (important for multipart/form-data)
      const contentType = req.headers.get('content-type')
      if (contentType) {
        fetchOpts.headers = { 'Content-Type': contentType }
      }
    }

    const r = await fetch(url, fetchOpts)
    const data = await r.arrayBuffer()

    // Forward the response with proper content type
    const respContentType = r.headers.get('Content-Type') || 'application/json'
    return new NextResponse(data, {
      status: r.status,
      headers: {
        'Content-Type': respContentType,
        'Content-Disposition': r.headers.get('Content-Disposition') || '',
      },
    })
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

export async function HEAD(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  return proxy(req, path, 'HEAD')
}
