/**
 * Java-serialization parser for caver.tunnels.Tunnels objects
 * -----------------------------------------------------------
 * CAVER 3.0.3 writes its tunnel results as a Java-serialized
 * `caver.tunnels.Tunnels` object (file: `data/tunnels/tunnels_*.obj`).
 *
 * Rather than requiring a JDK on the host (only the JRE is needed to *run*
 * caver.jar), we parse the binary serialization stream directly here.  We
 * only implement the subset of the Java Serialization Protocol (JSP) that
 * CAVER actually uses — enough to extract Tunnel objects and their TVE
 * edge arrays.
 *
 * JSP reference: https://docs.oracle.com/javase/8/docs/platform/serialization/spec/protocol.html
 *
 * Object graph produced by CAVER:
 *   Tunnels
 *     ├── origin: Point(x, y, z)  → starting point
 *     └── tunnels: TreeSet<Tunnel>
 *           └── Tunnel
 *                 ├── cost, curvature (double), id, number (int), length (double)
 *                 ├── bottleneck: Sphere { r: double, s: Point(x,y,z) }
 *                 ├── edges: TVE[]  (the tunnel polyline)
 *                 │     └── TVE { ax,ay,az, bx,by,bz, sr, sx,sy,sz }  (all doubles)
 *                 ├── snapPriority: Integer | null
 *                 ├── snap: SnapId | null
 *                 └── source: Point | null
 */

// --- JSP stream element type codes ---
const TC_NULL = 0x70
const TC_REFERENCE = 0x71
const TC_CLASSDESC = 0x72
const TC_OBJECT = 0x73
const TC_STRING = 0x74
const TC_ARRAY = 0x75
const TC_ENDBLOCKDATA = 0x78
const TC_BLOCKDATA = 0x77

// Primitive type codes (used in class descriptors)
const TYPE_DOUBLE = 0x44 // 'D'
const TYPE_FLOAT = 0x46 // 'F'
const TYPE_INT = 0x49 // 'I'
const TYPE_LONG = 0x4a // 'J'
const TYPE_OBJECT = 0x4c // 'L'
const TYPE_ARRAY = 0x5b // '['

interface FieldDesc {
  typecode: number
  name: string
}

interface ClassDesc {
  name: string
  fields: FieldDesc[]
  handle: number
  /** Whether this class has a custom writeObject (SC_WRITE_METHOD). */
  hasWriteMethod: boolean
}

/** Parsed tunnel edge (TVE = Triangulation Vertex Edge). */
interface TVE {
  ax: number; ay: number; az: number
  bx: number; by: number; bz: number
  sr: number; sx: number; sy: number; sz: number
}

/**
 * Minimal Java Serialization Protocol reader.
 * Reads only the constructs CAVER uses: objects with primitive + object
 * reference fields, arrays of objects, strings, and back-references.
 *
 * All parsed objects are registered in a handle table so the caller can
 * search the entire graph (including objects reachable only through
 * TreeSet/TreeMap custom writeObject data) for Tunnel-like objects.
 */
class JSEReader {
  private buf: Buffer
  private pos: number
  /** Maps handle → parsed value for TC_REFERENCE resolution. */
  private handles: unknown[] = []
  private classDescs = new Map<number, ClassDesc>()

  constructor(buf: Buffer) {
    this.buf = buf
    this.pos = 0
  }

  /** All parsed objects (handle table) — for graph-wide searches. */
  get allObjects(): unknown[] { return this.handles }

  private readU8(): number { const v = this.buf[this.pos]; this.pos++; return v }
  private readU16(): number { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v }
  private readI32(): number { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v }
  private readI64(): bigint { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v }
  private readF64(): number { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v }
  private readF32(): number { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v }
  private readUtf(): string {
    const len = this.readU16()
    const str = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return str
  }
  private addHandle(v: unknown): number {
    const h = this.handles.length
    this.handles.push(v)
    return h
  }

  /** Read the next content element. */
  readContent(): unknown {
    const tc = this.readU8()
    switch (tc) {
      case TC_NULL: return null
      case TC_REFERENCE: {
        const h = this.readI32()
        return this.handles[h - 0x7e0000]
      }
      case TC_STRING: {
        const s = this.readUtf()
        this.addHandle(s)
        return s
      }
      case TC_OBJECT: return this.readObject()
      case TC_ARRAY: return this.readArray()
      case TC_BLOCKDATA: {
        const len = this.readU8()
        this.pos += len
        return null
      }
      case TC_ENDBLOCKDATA: return undefined // signals end of annotation
      default:
        throw new Error(`JSE: unexpected TC=0x${tc.toString(16)} at pos ${this.pos - 1}`)
    }
  }

  /** Read a TC_OBJECT. */
  private readObject(): Record<string, unknown> {
    const cd = this.readClassDesc()
    const handle = this.addHandle(undefined) // reserve handle BEFORE reading fields (for cyclic refs)
    const obj: Record<string, unknown> = {}
    this.handles[handle] = obj
    this.readClassFields(cd, obj)
    // Object annotation (custom writeObject data) is ONLY present when the
    // class has SC_WRITE_METHOD.  Classes like TVE / Point / Sphere use
    // default serialization (no writeObject) so there is NO annotation block
    // after their fields — calling skipAnnotation() would wrongly consume
    // the next object's type byte.
    if (cd?.hasWriteMethod) {
      this.skipAnnotation()
    }
    return obj
  }

  /** Read all fields declared by `cd` and its superclasses into `obj`. */
  private readClassFields(cd: ClassDesc | null, obj: Record<string, unknown>): void {
    if (!cd) return
    // Java writes all primitive fields first (declaration order), then
    // all object-reference fields (declaration order).  We do two passes.
    for (const f of cd.fields) {
      switch (f.typecode) {
        case 0x5a: obj[f.name] = this.readU8() !== 0; break // boolean
        case 0x42: obj[f.name] = this.buf.readInt8(this.pos); this.pos++; break // byte
        case 0x43: obj[f.name] = this.readU16(); break // char
        case 0x53: { const v = this.buf.readInt16BE(this.pos); this.pos += 2; obj[f.name] = v; break } // short
        case TYPE_INT: obj[f.name] = this.readI32(); break
        case TYPE_LONG: obj[f.name] = this.readI64(); break
        case TYPE_FLOAT: obj[f.name] = this.readF32(); break
        case TYPE_DOUBLE: obj[f.name] = this.readF64(); break
        default: break // object/array — handled in second pass
      }
    }
    for (const f of cd.fields) {
      if (f.typecode === TYPE_OBJECT || f.typecode === TYPE_ARRAY) {
        obj[f.name] = this.readContent()
      }
    }
  }

  /** Read a class descriptor (TC_CLASSDESC, TC_REFERENCE, or TC_NULL). */
  private readClassDesc(): ClassDesc | null {
    const tc = this.readU8()
    if (tc === TC_NULL) return null
    if (tc === TC_REFERENCE) {
      // Back-reference to a previously-seen class descriptor
      const h = this.readI32()
      return this.classDescs.get(h - 0x7e0000) ?? null
    }
    if (tc !== TC_CLASSDESC) {
      throw new Error(`JSE: expected TC_CLASSDESC (0x72), got 0x${tc.toString(16)} at pos ${this.pos - 1}`)
    }
    // IMPORTANT: In the Java Serialization Protocol, the handle is assigned
    // to the class descriptor BEFORE its field type strings are written.
    // (The field type strings are separate TC_STRING elements that get
    // their own handles after the class descriptor's handle.)  We must
    // reserve the handle here, before reading the fields, so that
    // TC_REFERENCE back-references resolve correctly.
    const handle = this.addHandle(null)
    const name = this.readUtf()
    this.pos += 8 // serialVersionUID
    const flags = this.readU8() // classDescFlags
    const nFields = this.readU16()
    const fields: FieldDesc[] = []
    for (let i = 0; i < nFields; i++) {
      const typecode = this.readU8()
      const fname = this.readUtf()
      // For L and [ types, a class-name string follows
      if (typecode === TYPE_OBJECT || typecode === TYPE_ARRAY) {
        this.readContent() // consume the class-name string (or reference)
      }
      fields.push({ typecode, name: fname })
    }
    const cd: ClassDesc = { name, fields, handle, hasWriteMethod: (flags & 0x01) !== 0 }
    this.classDescs.set(handle, cd)
    this.skipAnnotation() // class annotation (always present, even if just TC_ENDBLOCKDATA)
    const superCd = this.readClassDesc()
    if (superCd) cd.fields = [...cd.fields, ...superCd.fields]
    return cd
  }

  /** Skip object annotation: read content elements until TC_ENDBLOCKDATA. */
  private skipAnnotation(): void {
    for (;;) {
      const tc = this.buf[this.pos]
      if (tc === TC_ENDBLOCKDATA) { this.pos++; return }
      const r = this.readContent()
      if (r === undefined) return // TC_ENDBLOCKDATA
    }
  }

  /** Read a TC_ARRAY. */
  private readArray(): unknown[] {
    const cd = this.readClassDesc()
    const len = this.readI32()
    const arr: unknown[] = []
    this.addHandle(arr)
    if (len < 0) return arr
    // Determine element type from the class descriptor name:
    //   [D = double[], [I = int[], [J = long[], [F = float[],
    //   [B = byte[], [Z = boolean[], [L...; = object array
    const elemName = cd?.name ?? ''
    if (elemName === '[D') {
      for (let i = 0; i < len; i++) arr.push(this.readF64())
    } else if (elemName === '[I') {
      for (let i = 0; i < len; i++) arr.push(this.readI32())
    } else if (elemName === '[J') {
      for (let i = 0; i < len; i++) arr.push(this.readI64())
    } else if (elemName === '[F') {
      for (let i = 0; i < len; i++) arr.push(this.readF32())
    } else if (elemName === '[B') {
      for (let i = 0; i < len; i++) arr.push(this.buf[this.pos++])
    } else if (elemName === '[Z') {
      for (let i = 0; i < len; i++) arr.push(this.readU8() !== 0)
    } else {
      // Object array — each element is a content element
      for (let i = 0; i < len; i++) arr.push(this.readContent())
    }
    return arr
  }
}

/** Search all parsed objects for Tunnel-like structures.
 *  CAVER's Tunnel class uses field names with trailing underscores
 *  (cost_, curvature_, id_, length_, number_, bottleneck_, edges_,
 *  snapPriority_, snap_, source_), while the TVE class uses bare names
 *  (ax, ay, az, bx, by, bz, sr, sx, sy, sz).  We check for the
 *  underscore-suffixed names to identify Tunnel objects. */
function findTunnels(allObjects: unknown[]): TunnelObj[] {
  const out: TunnelObj[] = []
  const seen = new WeakSet()
  for (const obj of allObjects) {
    if (!obj || typeof obj !== 'object') continue
    const o = obj as Record<string, unknown>
    // Tunnel signature: has `id_` (number), `edges_` (array), `length_` (number)
    if (typeof o.id_ !== 'number') continue
    if (typeof o.length_ !== 'number') continue
    if (!Array.isArray(o.edges_)) continue
    if (seen.has(obj as object)) continue
    seen.add(obj as object)
    const edges = (o.edges_ as unknown[]).filter(isTVE) as TVE[]
    const bottleneck = o.bottleneck_ as Record<string, unknown> | null
    const bnSphere = bottleneck && typeof bottleneck === 'object' && 'r_' in bottleneck
      ? { r: (bottleneck.r_ as number) ?? 0, s: pointFromObj(bottleneck.s_) }
      : null
    out.push({
      cost: o.cost_ as number,
      curvature: o.curvature_ as number,
      id: o.id_ as number,
      length: o.length_ as number,
      number: o.number_ as number,
      bottleneck: bnSphere,
      edges,
      snapPriority: o.snapPriority_ as number | null,
    })
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

function isTVE(x: unknown): x is TVE {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.ax === 'number' && typeof o.bx === 'number' && typeof o.sr === 'number'
}

function pointFromObj(v: unknown): { x: number; y: number; z: number } {
  if (!v || typeof v !== 'object') return { x: 0, y: 0, z: 0 }
  const o = v as Record<string, unknown>
  // CAVER Point fields also use trailing underscores (x_, y_, z_)
  return {
    x: (o.x_ as number) ?? (o.x as number) ?? 0,
    y: (o.y_ as number) ?? (o.y as number) ?? 0,
    z: (o.z_ as number) ?? (o.z as number) ?? 0,
  }
}

interface TunnelObj {
  cost: number
  curvature: number
  id: number
  length: number
  number: number
  bottleneck: { r: number; s: { x: number; y: number; z: number } } | null
  edges: TVE[]
  snapPriority: number | null
}

/** Convert a TunnelObj to the public CaverTunnel type. */
function tunnelToPublic(t: TunnelObj, clusterId: number): import('./types').CaverTunnel {
  const points: import('./types').CaverTunnelPoint[] = []
  for (let i = 0; i < t.edges.length; i++) {
    const e = t.edges[i]
    if (i === 0) points.push({ x: e.ax, y: e.ay, z: e.az, r: e.sr })
    points.push({ x: e.bx, y: e.by, z: e.bz, r: e.sr })
  }
  let minR = Infinity
  let bnPos: [number, number, number] | null = null
  for (const p of points) {
    if (p.r < minR) { minR = p.r; bnPos = [p.x, p.y, p.z] }
  }
  if (t.bottleneck) {
    minR = t.bottleneck.r
    bnPos = [t.bottleneck.s.x, t.bottleneck.s.y, t.bottleneck.s.z]
  }
  return {
    id: t.id,
    number: t.number,
    length: t.length,
    cost: t.cost,
    curvature: t.curvature,
    bottleneck_radius: minR === Infinity ? 0 : minR,
    bottleneck_position: bnPos,
    cluster_id: clusterId,
    points,
  }
}

/** Main entry: parse a caver .obj file and return all tunnels. */
export function parseTunnelsObj(buf: Buffer): import('./types').CaverTunnel[] {
  if (buf.length < 4 || buf[0] !== 0xac || buf[1] !== 0xed) {
    throw new Error('Not a Java serialized stream (bad magic)')
  }
  const reader = new JSEReader(buf)
  reader['pos'] = 4 // skip stream header
  reader.readContent()
  const tunnels = findTunnels(reader.allObjects)
  return tunnels.map(t => tunnelToPublic(t, t.id))
}

/** Build cluster summaries from the tunnel list. */
export function buildClusterSummaries(tunnels: import('./types').CaverTunnel[]): import('./types').CaverClusterSummary[] {
  const byCluster = new Map<number, import('./types').CaverTunnel[]>()
  for (const t of tunnels) {
    const arr = byCluster.get(t.cluster_id) ?? []
    arr.push(t)
    byCluster.set(t.cluster_id, arr)
  }
  const summaries: import('./types').CaverClusterSummary[] = []
  for (const [id, ts] of byCluster) {
    ts.sort((a, b) => a.cost - b.cost)
    const bns = ts.map(t => t.bottleneck_radius)
    const lengths = ts.map(t => t.length)
    const curvs = ts.map(t => t.curvature)
    const throughputs = ts.map(t => 1 / (1 + t.cost))
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1)
    summaries.push({
      id,
      n_tunnels: ts.length,
      avg_bottleneck: avg(bns),
      max_bottleneck: Math.max(...bns),
      avg_length: avg(lengths),
      avg_curvature: avg(curvs),
      priority: avg(throughputs),
      avg_throughput: avg(throughputs),
      representative_tunnel_id: ts[0]?.id ?? null,
    })
  }
  summaries.sort((a, b) => b.priority - a.priority)
  return summaries
}
