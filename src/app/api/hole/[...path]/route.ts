/**
 * Next.js proxy for the HOLE2 Python mini-service (port 3001).
 *
 * The browser calls relative paths under /api/hole/* (e.g.
 * /api/hole/health) and this route handler forwards them to
 * http://127.0.0.1:3001/api/*. This has three advantages over calling the
 * Python service directly (or through the sandbox gateway):
 *
 *   1. Works from any origin (no CORS, no XTransformPort gateway needed),
 *      including `next start` on a bare port and `next dev`.
 *   2. The Python service is spawned *as a child of the Next.js server* on
 *      first request, so it inherits the server's process lifetime — the
 *      sandbox reaps loose background processes between tool calls, but the
 *      Next.js server is managed by the sandbox and keeps running.
 *   3. Self-healing: every request re-checks the service and respawns it
 *      if it died.
 */

import { NextRequest } from 'next/server'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SERVICE_HOST = process.env.HOLE2_SERVICE_HOST || '127.0.0.1'
const SERVICE_PORT = parseInt(process.env.HOLE2_SERVICE_PORT || '3001', 10)
const SERVICE_DIR = path.join(process.cwd(), 'mini-services', 'hole2-service')
const SERVICE_UPSTREAM = process.env.HOLE2_SERVICE_URL || `http://${SERVICE_HOST}:${SERVICE_PORT}`
const MAX_BODY_BYTES = 60 * 1024 * 1024  // PDB (≤50 MB) + rad file + multipart overhead

declare global {
  var __hole2Child: ChildProcess | undefined
  var __hole2Starting: Promise<boolean> | undefined
}

/** Quick TCP probe: is anything listening on the service port? */
function isServiceUp(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: SERVICE_HOST, port: SERVICE_PORT })
    const done = (ok: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Spawn uvicorn as a child of this Next.js server process (the sandbox
 *  keeps the server alive, so the Python service survives with it). */
function spawnService(): void {
  const prev = global.__hole2Child
  if (prev && !prev.killed && prev.exitCode === null) return

  const child = spawn(
    'python3',
    ['-m', 'uvicorn', 'main:app', '--host', SERVICE_HOST, '--port', String(SERVICE_PORT)],
    {
      cwd: SERVICE_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false, // stay a direct child of the Next.js server
      env: process.env,
    },
  )
  child.once('exit', (code) => {
    if (global.__hole2Child === child) {
      global.__hole2Child = undefined
      global.__hole2Starting = undefined
    }
    console.log(`[hole2-proxy] python service exited with code ${code}`)
  })
  global.__hole2Child = child
  console.log('[hole2-proxy] spawned python uvicorn service on port 3001')
}

/** Ensure the Python service is up (spawning it if needed) exactly once. */
async function ensureService(): Promise<boolean> {
  if (await isServiceUp()) return true
  if (!global.__hole2Starting) {
    global.__hole2Starting = (async () => {
      spawnService()
      // Wait up to 25 s for the service to come up (first import of FastAPI
      // + the app module can take a few seconds on a cold start).
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await isServiceUp(600)) return true
      }
      return false
    })()
  }
  return global.__hole2Starting
}

/** Forward a request to the Python service and return its Response. */
async function proxy(req: NextRequest): Promise<Response> {
  const ok = await ensureService()
  if (!ok) {
    return Response.json(
      { detail: 'HOLE2 Python service is not reachable on port 3001 and could not be started. See server logs.' },
      { status: 503 },
    )
  }

  // /api/hole/<rest>  ->  http://127.0.0.1:3001/api/<rest>
  const rest = req.nextUrl.pathname.replace(/^\/api\/hole/, '')
  const target = new URL(`${SERVICE_UPSTREAM}/api${rest}${req.nextUrl.search}`)

  const headers = new Headers(req.headers)
  headers.delete('host')
  headers.delete('connection')
  headers.delete('content-length') // recomputed for the buffered body
  // undici's fetch refuses to forward "Expect: 100-continue" (curl sends it
  // for large multipart uploads) — strip it, we buffer the body anyway.
  headers.delete('expect')

  try {
    const t0 = Date.now()
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    // Buffer the request body (up to the upload cap) rather than streaming it.
    // Streaming with duplex:'half' proved unreliable for multi-MB multipart
    // uploads under the Node fetch implementation Next.js ships.
    let body: ArrayBuffer | undefined
    if (hasBody) {
      body = await req.arrayBuffer()
      if (body.byteLength > MAX_BODY_BYTES) {
        return Response.json(
          { detail: `Request body too large (> ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB).` },
          { status: 413 },
        )
      }
    }
    const tBody = Date.now()
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000), // HOLE runs can be slow
    })
    const tFetch = Date.now()
    const respBody = await upstream.arrayBuffer()
    const tResp = Date.now()
    console.log(`[hole2-proxy] ${req.method} ${rest}: body=${tBody - t0}ms fetch=${tFetch - tBody}ms resp=${tResp - tFetch}ms (${body?.byteLength ?? 0}B up / ${respBody.byteLength}B down)`)

    const respHeaders = new Headers()
    const passThrough = ['content-type', 'content-disposition']
    for (const h of passThrough) {
      const v = upstream.headers.get(h)
      if (v) respHeaders.set(h, v)
    }
    return new Response(respBody, {
      status: upstream.status,
      headers: respHeaders,
    })
  } catch (e) {
    // The service may have died mid-request — mark it for respawn.
    global.__hole2Starting = undefined
    const err = e as Error & { cause?: unknown }
    const msg = err?.message ?? String(e)
    const cause = err?.cause instanceof Error ? ` (cause: ${err.cause.message})` : ''
    console.error(`[hole2-proxy] ${req.method} ${rest} failed: ${msg}${cause}`)
    if (err?.cause) console.error('[hole2-proxy] cause detail:', err.cause)
    return Response.json({ detail: `HOLE2 service request failed: ${msg}${cause}` }, { status: 502 })
  }
}

export async function GET(req: NextRequest) {
  return proxy(req)
}

export async function POST(req: NextRequest) {
  return proxy(req)
}

export async function HEAD(req: NextRequest) {
  return proxy(req)
}