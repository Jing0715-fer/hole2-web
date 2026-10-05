/**
 * GET /api/job/[job_id]/zip
 *
 * Stream a ZIP archive of all output files for a job.
 *
 * We hand-roll the ZIP container format (no external deps) using Node's
 * built-in `zlib.deflateSync` for the compressed file payloads.  The format
 * is:
 *   - For each file: local file header (30B) + filename + deflated data
 *   - Central directory file header (46B) per file
 *   - End of central directory record (22B)
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, readdirSync, statSync } from 'fs'
import { deflateSync } from 'zlib'
import path from 'path'
import { isValidJobId, jobDirPath } from '@/lib/hole/hole-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3 polynomial — same one used by ZIP/PNG/gzip).
// ---------------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  CRC_TABLE = table
  return table
}

function crc32(buf: Buffer): number {
  const table = crcTable()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  crc: number
  size: number
  compressedSize: number
  offset: number
  // 0 = stored, 8 = deflated
  method: number
}

/** Build a ZIP archive containing the given files (named by relative path).
 *  Returns a single Buffer with the complete ZIP file. */
export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const entries: ZipEntry[] = []
  let offset = 0

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8')
    const crc = crc32(f.data)
    // Use deflate for any payload > 32 bytes; smaller files are stored as-is.
    const method = f.data.length > 32 ? 8 : 0
    const compressed = method === 8 ? deflateSync(f.data) : f.data
    const stored = method === 0 ? f.data : compressed

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)  // signature
    localHeader.writeUInt16LE(20, 4)            // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6)        // flags: UTF-8 filename
    localHeader.writeUInt16LE(method, 8)        // compression method
    localHeader.writeUInt16LE(0, 10)            // mod time
    localHeader.writeUInt16LE(0, 12)            // mod date
    localHeader.writeUInt32LE(crc, 14)          // CRC-32
    localHeader.writeUInt32LE(stored.length, 18) // compressed size
    localHeader.writeUInt32LE(f.data.length, 22) // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26) // filename length
    localHeader.writeUInt16LE(0, 28)             // extra field length

    chunks.push(localHeader, nameBuf, stored)
    entries.push({
      name: f.name,
      crc,
      size: f.data.length,
      compressedSize: stored.length,
      offset,
      method,
    })
    offset += localHeader.length + nameBuf.length + stored.length
  }

  // Central directory
  let cdOffset = offset
  let cdSize = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)        // signature
    header.writeUInt16LE(20, 4)                  // version made by (2.0)
    header.writeUInt16LE(20, 6)                  // version needed
    header.writeUInt16LE(0x0800, 8)              // flags: UTF-8 filename
    header.writeUInt16LE(e.method, 10)           // compression method
    header.writeUInt16LE(0, 12)                  // mod time
    header.writeUInt16LE(0, 14)                  // mod date
    header.writeUInt32LE(e.crc, 16)              // CRC-32
    header.writeUInt32LE(e.compressedSize, 20)   // compressed size
    header.writeUInt32LE(e.size, 24)             // uncompressed size
    header.writeUInt16LE(nameBuf.length, 28)     // filename length
    header.writeUInt16LE(0, 30)                  // extra field length
    header.writeUInt16LE(0, 32)                  // comment length
    header.writeUInt16LE(0, 34)                   // disk number start
    header.writeUInt16LE(0, 36)                   // internal attrs
    header.writeUInt32LE(0, 38)                   // external attrs
    header.writeUInt32LE(e.offset, 42)            // offset of local header
    chunks.push(header, nameBuf)
    cdSize += header.length + nameBuf.length
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)              // signature
  eocd.writeUInt16LE(0, 4)                       // disk number
  eocd.writeUInt16LE(0, 6)                       // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)          // entries on this disk
  eocd.writeUInt16LE(entries.length, 10)         // total entries
  eocd.writeUInt32LE(cdSize, 12)                 // central directory size
  eocd.writeUInt32LE(cdOffset, 16)               // offset of central directory
  eocd.writeUInt16LE(0, 20)                      // comment length
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ job_id: string }> },
) {
  const { job_id: jobId } = await ctx.params
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ detail: 'Invalid job_id' }, { status: 400 })
  }
  const jobDir = jobDirPath(jobId)
  if (!jobDir) {
    return NextResponse.json({ detail: 'Unknown job_id' }, { status: 404 })
  }

  const files: { name: string; data: Buffer }[] = []
  for (const name of readdirSync(jobDir).sort()) {
    const full = path.join(jobDir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      files.push({ name, data: readFileSync(full) })
    } catch { /* skip unreadable */ }
  }

  if (files.length === 0) {
    return NextResponse.json({ detail: 'No output files in job directory' }, { status: 404 })
  }

  const zip = buildZip(files)
  return new NextResponse(zip, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="hole2-${jobId}.zip"`,
      'Content-Length': String(zip.length),
    },
  })
}
