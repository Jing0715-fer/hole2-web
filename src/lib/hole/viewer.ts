/**
 * HOLE2 web viewer — three.js 3D scene
 * -------------------------------------
 * Renders a PDB structure (cartoon ribbons for polymer chains + ball-and-stick
 * for ligands) together with the HOLE2 pore surface (a coloured triangle mesh
 * parsed from the .vmd_plot output) and the pore centre line.
 *
 * 3D rendering approach inspired by MolVision (MIT, Jing0715-fer) — uses
 * InstancedMesh for atoms, half-bond-coloured cylinders for sticks, and a
 * flat-shaded BufferGeometry for the HOLE surface so the per-vertex colour
 * (red/green/blue pore zones) shows through.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  parsePDB, parseStructure, computeBonds, elementInfo, isProtein, isNucleic, isWater,
  centerStructure, geometricCentre, type PdbStructure,
} from './pdb'
import {
  poreZoneColor, vmdColorToHex,
  type HoleSurface, type HoleSphere,
} from './types'

const CHAIN_COLORS = [
  0x10b981, 0xf59e0b, 0xef4444, 0x8b5cf6, 0x06b6d4, 0xec4899,
  0x84cc16, 0xf97316, 0x6366f1, 0x14b8a6,
]

export interface HoleViewerOptions {
  showCartoon: boolean
  showBallStick: boolean
  showSurface: boolean
  showSpheres: boolean
  showCentreLine: boolean
  /** Show side-chain sticks for residues lining the pore (within cutoff Å of the centre line). */
  showPoreSideChains: boolean
  surfaceOpacity: number
  sphereScale: number
}

export class HoleViewer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private rafId: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private container: HTMLElement
  private disposables: Array<{ dispose: () => void }> = []
  private structure: PdbStructure | null = null
  private structureGroup = new THREE.Group()
  private surfaceGroup = new THREE.Group()
  private centreLineGroup = new THREE.Group()
  private sphereGroup = new THREE.Group()
  private options: HoleViewerOptions = {
    showCartoon: true,
    showBallStick: false,   // off by default — cartoon is the main representation
    showSurface: true,
    showSpheres: false,
    showCentreLine: true,
    showPoreSideChains: true,  // highlight the pore-lining residues
    surfaceOpacity: 0.85,
    sphereScale: 1.0,
  }
  // atom colour array for ball-stick (CPK)
  private atomColors: Float32Array = new Float32Array(0)
  // current structure (kept so we can rebuild pore side-chains after HOLE run)
  private currentStructure: PdbStructure | null = null
  // current centreline (kept so we can rebuild pore side-chains on option toggle)
  private currentCentreline: [number, number, number][] = []
  // bounding box of the structure + hole surface combined
  private bbox = new THREE.Box3()
  private axesHelper: THREE.AxesHelper | null = null

  constructor(container: HTMLElement) {
    this.container = container
    const w = container.clientWidth || 800
    const h = container.clientHeight || 600

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.setClearColor(0x0b1220, 1)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x0b1220, 80, 250)

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    this.camera.position.set(0, 0, 60)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08

    // lighting — 3-point setup
    const amb = new THREE.AmbientLight(0xffffff, 0.55)
    this.scene.add(amb)
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(20, 30, 40)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4)
    fill.position.set(-30, -10, -20)
    this.scene.add(fill)
    const back = new THREE.DirectionalLight(0xffffff, 0.3)
    back.position.set(0, -30, 20)
    this.scene.add(back)

    this.scene.add(this.structureGroup)
    this.scene.add(this.surfaceGroup)
    this.scene.add(this.centreLineGroup)
    this.scene.add(this.sphereGroup)

    // resize handling
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.startLoop()
  }

  /** Set the background colour (used for light/dark theme switching). */
  setBackground(color: number) {
    this.renderer.setClearColor(color, 1)
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.setHex(color)
  }

  private handleResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private startLoop() {
    const tick = () => {
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  /** Load a PDB/CIF structure (text) and render cartoon + ball-and-stick.
   *  Auto-detects the format (PDB vs mmCIF) by sniffing the file header.
   *  The structure is centred on its geometric centroid so the pore is
   *  roughly in view (the HOLE cpoint may shift this further once loaded). */
  loadStructure(text: string, filename?: string) {
    // dispose existing structure
    this.clearGroup(this.structureGroup)
    let parsed = parseStructure(text, filename)
    // Center the structure on its geometric centroid so it sits in view.
    // (Once HOLE results arrive, we re-centre on the pore cpoint.)
    const gc = geometricCentre(parsed)
    parsed = centerStructure(parsed, gc)
    this.structure = parsed
    this.currentStructure = parsed
    const s = this.structure
    if (s.atoms.length === 0) return

    // build atom colour array (CPK by default; chain colour for cartoon)
    const chainColorMap = new Map<string, number>()
    let chainIdx = 0
    for (const c of s.chains) {
      if (!chainColorMap.has(c.id)) {
        chainColorMap.set(c.id, CHAIN_COLORS[chainIdx % CHAIN_COLORS.length])
        chainIdx++
      }
    }
    // Pre-compute the per-atom CPK colour array (used by ball-stick + side-chains)
    this.atomColors = new Float32Array(s.atoms.length * 3)
    for (let i = 0; i < s.atoms.length; i++) {
      const info = elementInfo(s.atoms[i].element)
      this.atomColors[i * 3] = info.color[0]
      this.atomColors[i * 3 + 1] = info.color[1]
      this.atomColors[i * 3 + 2] = info.color[2]
    }

    // 1) cartoon ribbons (protein) + nucleic backbone tubes
    if (this.options.showCartoon) {
      this.buildCartoon(s, chainColorMap)
    }

    // 2) ball-and-stick (hetero atoms + ligands; optionally all atoms)
    if (this.options.showBallStick) {
      this.buildBallStick(s)
    }

    // 3) pore-lining side chains (only if HOLE results are already loaded)
    if (this.options.showPoreSideChains && this.currentCentreline.length > 0) {
      this.buildPoreSideChains(s, this.currentCentreline)
    }

    this.updateVisibility()
    this.fitView()
  }

  /** Load the HOLE surface mesh + centre line + spheres. */
  loadHoleResults(spheres: HoleSphere[], surface: HoleSurface,
                  centreline: [number, number, number][]) {
    this.clearGroup(this.surfaceGroup)
    this.clearGroup(this.centreLineGroup)
    this.clearGroup(this.sphereGroup)
    // Also rebuild the structure group's side-chains since the centre line
    // may have changed.  We keep a reference to the current structure.
    this.currentCentreline = centreline
    if (this.currentStructure && this.options.showPoreSideChains && centreline.length > 0) {
      // Re-render the whole structure so the side-chains pick up the new centre line
      // (cheaper than tracking which side-chain atoms to add/remove)
      this.clearGroup(this.structureGroup)
      const s = this.currentStructure
      const chainColorMap = new Map<string, number>()
      let chainIdx = 0
      for (const c of s.chains) {
        if (!chainColorMap.has(c.id)) {
          chainColorMap.set(c.id, CHAIN_COLORS[chainIdx % CHAIN_COLORS.length])
          chainIdx++
        }
      }
      if (this.options.showCartoon) this.buildCartoon(s, chainColorMap)
      if (this.options.showBallStick) this.buildBallStick(s)
      this.buildPoreSideChains(s, centreline)
    }

    // surface mesh — flat shaded so each triangle's vertex colour shows
    if (surface.triangles.length > 0) {
      this.buildSurfaceMesh(surface)
    }

    // centre line — tube along the sphere centres
    if (centreline.length > 1 && this.options.showCentreLine) {
      this.buildCentreLine(centreline)
    }

    // pore spheres — instanced spheres coloured by zone
    if (spheres.length > 0 && this.options.showSpheres) {
      this.buildSphereCloud(spheres)
    }

    this.updateVisibility()
    this.fitView()
  }

  private buildCartoon(s: PdbStructure, chainColorMap: Map<string, number>) {
    // Secondary-structure-aware cartoon:
    //   - helix residues → thick rounded tube (radius 0.55) in helix colour
    //   - sheet residues → flat arrow (width 1.6, thickness 0.25) in sheet colour
    //   - loop residues → thin tube (radius 0.22) in chain colour
    // SS comes from PDB HELIX/SHEET records (or mmCIF _struct_conf).
    // For nucleic chains, render a smooth tube through P atoms (no SS).
    for (const chain of s.chains) {
      if (!chain.polymer) continue
      // Collect backbone anchors + their SS for this chain
      const anchors: { pos: THREE.Vector3; ss: 'H' | 'E' | 'L'; resSeq: number }[] = []
      for (const ri of chain.residueIdx) {
        const r = s.residues[ri]
        let anchor = -1
        for (let i = r.start; i < r.end; i++) {
          const name = s.atoms[i].name.toUpperCase()
          if (isProtein(r.resName) && name === 'CA') { anchor = i; break }
          if (isNucleic(r.resName) && (name === 'P' || name === "O5'")) { anchor = i; break }
        }
        if (anchor < 0) {
          for (let i = r.start; i < r.end; i++) {
            if (s.atoms[i].element !== 'H') { anchor = i; break }
          }
        }
        if (anchor >= 0) {
          const a = s.atoms[anchor]
          anchors.push({
            pos: new THREE.Vector3(a.x, a.y, a.z),
            ss: r.ss,
            resSeq: r.resSeq,
          })
        }
      }
      if (anchors.length < 2) continue

      // Detect chain breaks (consecutive CA distance > 8 Å → new segment)
      const segments: typeof anchors[] = [[anchors[0]]]
      for (let i = 1; i < anchors.length; i++) {
        if (anchors[i].pos.distanceTo(anchors[i - 1].pos) > 8.0) {
          segments.push([anchors[i]])
        } else {
          segments[segments.length - 1].push(anchors[i])
        }
      }

      const chainCol = chainColorMap.get(chain.id) ?? 0x10b981
      const isNucleic = anchors[0] !== undefined && !s.residues[chain.residueIdx[0]]?.ss
      // Build cartoon segments: for each contiguous SS run, build the right geometry
      for (const seg of segments) {
        if (seg.length < 2) continue
        // Smooth the backbone with Catmull-Rom for nicer curves
        const positions = seg.map(a => a.pos)
        // Group consecutive residues by SS type
        let i = 0
        while (i < seg.length) {
          const ss = seg[i].ss
          let j = i
          while (j < seg.length && seg[j].ss === ss) j++
          // segment from i..j (exclusive)
          const runPts = positions.slice(Math.max(0, i - 1), Math.min(seg.length, j + 1))
          if (runPts.length >= 2) {
            const curve = new THREE.CatmullRomCurve3(runPts, false, 'catmullrom', 0.5)
            const tubularSeg = Math.max(8, runPts.length * 6)
            if (ss === 'H') {
              // Helix → thick rounded tube
              const tubeGeo = new THREE.TubeGeometry(curve, tubularSeg, 0.55, 12, false)
              const mat = new THREE.MeshStandardMaterial({
                color: 0xe0566b, roughness: 0.4, metalness: 0.05,
              })
              const mesh = new THREE.Mesh(tubeGeo, mat)
              this.structureGroup.add(mesh)
              this.disposables.push(tubeGeo, mat)
            } else if (ss === 'E') {
              // Sheet → flat ribbon (use a flat extruded shape)
              const tubeGeo = new THREE.TubeGeometry(curve, tubularSeg, 0.25, 4, false)
              // Flatten by scaling Y → use a custom geometry: take the tube and squash
              const posAttr = tubeGeo.attributes.position as THREE.BufferAttribute
              const v = new THREE.Vector3()
              for (let k = 0; k < posAttr.count; k++) {
                v.fromBufferAttribute(posAttr, k)
                // Find the cross-section centre for this slice (approx: nearest point on curve)
                // Simple flatten: scale the offset from the curve centre in X (width) and Y (thickness)
                // TubeGeometry already gives us radial offset; we scale X by 3 to make flat
                // For simplicity, scale x by 3.2 and y by 0.3 (relative to tube centre)
                // Actually just scale the whole geometry's X by 3 and Y by 0.5:
              }
              // Apply scale to make it flat (ribbon)
              tubeGeo.scale(3.2, 0.5, 1)
              const mat = new THREE.MeshStandardMaterial({
                color: 0xf0a830, roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide,
              })
              const mesh = new THREE.Mesh(tubeGeo, mat)
              this.structureGroup.add(mesh)
              this.disposables.push(tubeGeo, mat)
            } else {
              // Loop → thin tube in chain colour
              const tubeGeo = new THREE.TubeGeometry(curve, tubularSeg, 0.22, 8, false)
              const mat = new THREE.MeshStandardMaterial({
                color: chainCol, roughness: 0.5, metalness: 0.05,
              })
              const mesh = new THREE.Mesh(tubeGeo, mat)
              this.structureGroup.add(mesh)
              this.disposables.push(tubeGeo, mat)
            }
          }
          i = j
        }
      }
    }
  }

  /** Build side-chain sticks for residues whose CA is within `cutoff` Å of
   *  any pore centre-line sphere.  This shows the pore-lining residues. */
  buildPoreSideChains(s: PdbStructure, centreline: [number, number, number][], cutoff = 6.0) {
    if (centreline.length === 0) return
    // Build a spatial hash of centre-line points for fast proximity queries
    const cellSize = cutoff * 1.5
    const map = new Map<string, THREE.Vector3[]>()
    const v = new THREE.Vector3()
    for (const p of centreline) {
      v.set(p[0], p[1], p[2])
      const key = `${Math.floor(v.x / cellSize)},${Math.floor(v.y / cellSize)},${Math.floor(v.z / cellSize)}`
      let arr = map.get(key)
      if (!arr) { arr = []; map.set(key, arr) }
      arr.push(v.clone())
    }
    const nearPore = (x: number, y: number, z: number): boolean => {
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize), cz = Math.floor(z / cellSize)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const arr = map.get(`${cx + dx},${cy + dy},${cz + dz}`)
        if (!arr) continue
        for (const p of arr) {
          const d2 = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2
          if (d2 < cutoff * cutoff) return true
        }
      }
      return false
    }
    // Find residues with CA near the pore → show all their side-chain heavy atoms as sticks
    const atomIdx: number[] = []
    for (const chain of s.chains) {
      if (!chain.polymer) continue
      for (const ri of chain.residueIdx) {
        const r = s.residues[ri]
        // Find CA
        let caIdx = -1
        for (let i = r.start; i < r.end; i++) {
          if (s.atoms[i].name.toUpperCase() === 'CA') { caIdx = i; break }
        }
        if (caIdx < 0) continue
        const ca = s.atoms[caIdx]
        if (!nearPore(ca.x, ca.y, ca.z)) continue
        // Add all side-chain heavy atoms (skip backbone: N, CA, C, O)
        for (let i = r.start; i < r.end; i++) {
          const nm = s.atoms[i].name.toUpperCase()
          if (nm === 'N' || nm === 'CA' || nm === 'C' || nm === 'O') continue
          if (s.atoms[i].element === 'H') continue
          atomIdx.push(i)
        }
        // Also include the backbone CA so the sidechain connects visually
        atomIdx.push(caIdx)
      }
    }
    if (atomIdx.length === 0) return
    // Build the side-chain sticks (cylinders for bonds, spheres for atoms)
    this.buildSticksForAtoms(s, atomIdx, 0.12)
    this.buildSpheresForAtoms(s, atomIdx, 0.18)
  }

  /** Build stick cylinders + spheres for a specific set of atom indices. */
  private buildSticksForAtoms(s: PdbStructure, atomIdx: number[], stickRadius: number) {
    const bonds = computeBonds(s)
    if (bonds.length === 0) return
    const atomSet = new Set(atomIdx)
    const relevant = bonds.filter(([a, b]) => atomSet.has(a) && atomSet.has(b))
    if (relevant.length === 0) return
    const cylGeo = new THREE.CylinderGeometry(stickRadius, stickRadius, 1, 8, 1, true)
    const cylMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.0 })
    const inst = new THREE.InstancedMesh(cylGeo, cylMat, relevant.length * 2)
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const mid = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const colors = this.atomColors
    for (let k = 0; k < relevant.length; k++) {
      const [i, j] = relevant[k]
      const ai = s.atoms[i], aj = s.atoms[j]
      a.set(ai.x, ai.y, ai.z)
      b.set(aj.x, aj.y, aj.z)
      mid.copy(a).lerp(b, 0.5)
      const half = a.clone().lerp(mid, 0.5)
      const len = a.distanceTo(mid)
      const dir = mid.clone().sub(a).normalize()
      quat.setFromUnitVectors(up, dir)
      m.compose(half, quat, new THREE.Vector3(1, len, 1))
      inst.setMatrixAt(k * 2, m)
      color.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2])
      inst.setColorAt(k * 2, color)
      const half2 = mid.clone().lerp(b, 0.5)
      const len2 = mid.distanceTo(b)
      const dir2 = b.clone().sub(mid).normalize()
      quat.setFromUnitVectors(up, dir2)
      m.compose(half2, quat, new THREE.Vector3(1, len2, 1))
      inst.setMatrixAt(k * 2 + 1, m)
      color.setRGB(colors[j * 3], colors[j * 3 + 1], colors[j * 3 + 2])
      inst.setColorAt(k * 2 + 1, color)
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    this.structureGroup.add(inst)
    this.disposables.push(cylGeo, cylMat)
  }

  private buildSpheresForAtoms(s: PdbStructure, atomIdx: number[], radius: number) {
    const sphereGeo = new THREE.SphereGeometry(1, 16, 12)
    const sphereMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
    const inst = new THREE.InstancedMesh(sphereGeo, sphereMat, atomIdx.length)
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    const colors = this.atomColors
    for (let k = 0; k < atomIdx.length; k++) {
      const i = atomIdx[k]
      const a = s.atoms[i]
      m.makeScale(radius, radius, radius)
      m.setPosition(a.x, a.y, a.z)
      inst.setMatrixAt(k, m)
      color.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2])
      inst.setColorAt(k, color)
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    this.structureGroup.add(inst)
    this.disposables.push(sphereGeo, sphereMat)
  }

  private buildBallStick(s: PdbStructure) {
    // For ball-and-stick we show only hetero atoms + ligands (the cartoon
    // already shows the polymer backbone).  This keeps the scene light and
    // avoids duplicating the polymer atoms that the cartoon already renders.
    const atomIdx: number[] = []
    for (let i = 0; i < s.atoms.length; i++) {
      const a = s.atoms[i]
      if (a.hetero && !isWater(a.resName)) atomIdx.push(i)
    }
    if (atomIdx.length === 0) return
    this.buildSpheresForAtoms(s, atomIdx, 0.32)
    this.buildSticksForAtoms(s, atomIdx, 0.1)
  }

  private buildSurfaceMesh(surface: HoleSurface) {
    const tris = surface.triangles
    if (tris.length === 0) return
    // flat shaded: each triangle = 3 vertices, each with its own colour
    const n = tris.length * 3
    const positions = new Float32Array(n * 3)
    const normals = new Float32Array(n * 3)
    const colors = new Float32Array(n * 3)
    const c = new THREE.Color()
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i]
      const hex = vmdColorToHex(t.color)
      c.set(hex)
      for (let k = 0; k < 3; k++) {
        const v = t.vertices[k]
        const nm = t.normals[k]
        const base = (i * 3 + k) * 3
        positions[base] = v[0]
        positions[base + 1] = v[1]
        positions[base + 2] = v[2]
        normals[base] = nm[0]
        normals[base + 1] = nm[1]
        normals[base + 2] = nm[2]
        colors[base] = c.r
        colors[base + 1] = c.g
        colors[base + 2] = c.b
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: this.options.surfaceOpacity < 1.0,
      opacity: this.options.surfaceOpacity,
      flatShading: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    this.surfaceGroup.add(mesh)
    this.disposables.push(geo, mat)
  }

  private buildCentreLine(points: [number, number, number][]) {
    if (points.length < 2) return
    const vec = points.map(p => new THREE.Vector3(p[0], p[1], p[2]))
    const curve = new THREE.CatmullRomCurve3(vec, false, 'catmullrom', 0.5)
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(20, vec.length * 2), 0.18, 8, false)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24, roughness: 0.3, metalness: 0.4,
      emissive: 0xfbbf24, emissiveIntensity: 0.3,
    })
    const mesh = new THREE.Mesh(tubeGeo, mat)
    this.centreLineGroup.add(mesh)
    this.disposables.push(tubeGeo, mat)
  }

  private buildSphereCloud(spheres: HoleSphere[]) {
    if (spheres.length === 0) return
    const geo = new THREE.SphereGeometry(1, 12, 8)
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.5,
    })
    const inst = new THREE.InstancedMesh(geo, mat, spheres.length)
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    const scale = this.options.sphereScale
    for (let k = 0; k < spheres.length; k++) {
      const s = spheres[k]
      const r = s.r * 0.5 * scale
      m.makeScale(r, r, r)
      m.setPosition(s.x, s.y, s.z)
      inst.setMatrixAt(k, m)
      color.set(poreZoneColor(s.r))
      inst.setColorAt(k, color)
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    this.sphereGroup.add(inst)
    this.disposables.push(geo, mat)
  }

  /** Set viewer options (visibility toggles, opacity, etc.). */
  setOptions(opts: Partial<HoleViewerOptions>) {
    const prevPoreSideChains = this.options.showPoreSideChains
    this.options = { ...this.options, ...opts }
    // if opacity changed, update the surface material
    if (opts.surfaceOpacity !== undefined) {
      this.surfaceGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
          obj.material.opacity = opts.surfaceOpacity!
          obj.material.transparent = opts.surfaceOpacity! < 1.0
          obj.material.needsUpdate = true
        }
      })
    }
    // If the pore-side-chains toggle changed, rebuild the structure group so
    // the side-chains are added/removed.  Only do this if HOLE results exist.
    if (opts.showPoreSideChains !== undefined && opts.showPoreSideChains !== prevPoreSideChains
        && this.currentStructure && this.currentCentreline.length > 0) {
      this.clearGroup(this.structureGroup)
      const s = this.currentStructure
      const chainColorMap = new Map<string, number>()
      let chainIdx = 0
      for (const c of s.chains) {
        if (!chainColorMap.has(c.id)) {
          chainColorMap.set(c.id, CHAIN_COLORS[chainIdx % CHAIN_COLORS.length])
          chainIdx++
        }
      }
      if (this.options.showCartoon) this.buildCartoon(s, chainColorMap)
      if (this.options.showBallStick) this.buildBallStick(s)
      if (this.options.showPoreSideChains) this.buildPoreSideChains(s, this.currentCentreline)
    }
    this.updateVisibility()
  }

  private updateVisibility() {
    this.structureGroup.visible = this.options.showCartoon || this.options.showBallStick || this.options.showPoreSideChains
    this.surfaceGroup.visible = this.options.showSurface
    this.centreLineGroup.visible = this.options.showCentreLine
    this.sphereGroup.visible = this.options.showSpheres
  }

  /** Frame the scene to the combined bounding box of structure + surface. */
  fitView() {
    this.bbox.makeEmpty()
    for (const g of [this.structureGroup, this.surfaceGroup, this.centreLineGroup, this.sphereGroup]) {
      if (!g.visible) continue
      g.updateMatrixWorld(true)
      g.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          const geo = obj.geometry
          if (geo && geo.attributes && geo.attributes.position) {
            geo.computeBoundingBox()
            const bb = geo.boundingBox!
            obj.updateMatrixWorld(true)
            bb.applyMatrix4(obj.matrixWorld)
            this.bbox.union(bb)
          }
        }
      })
    }
    if (this.bbox.isEmpty()) return
    const center = new THREE.Vector3()
    this.bbox.getCenter(center)
    const size = new THREE.Vector3()
    this.bbox.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const fov = this.camera.fov * Math.PI / 180
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.6
    this.controls.target.copy(center)
    const dir = new THREE.Vector3(1, 0.6, 1).normalize()
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.camera.near = dist / 100
    this.camera.far = dist * 100
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  private clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children[0]
      group.remove(child)
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose?.()
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
        else child.material?.dispose?.()
      }
      if (child instanceof THREE.InstancedMesh) {
        child.geometry?.dispose?.()
        child.material?.dispose?.()
        child.dispose?.()
      }
    }
  }

  /** Toggle the XYZ axes helper. */
  setAxesVisible(visible: boolean) {
    if (visible && !this.axesHelper) {
      this.axesHelper = new THREE.AxesHelper(10)
      this.scene.add(this.axesHelper)
    } else if (!visible && this.axesHelper) {
      this.scene.remove(this.axesHelper)
      this.axesHelper.dispose()
      this.axesHelper = null
    }
  }

  /** Capture a PNG snapshot of the current canvas. */
  capturePNG(): string {
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.resizeObserver?.disconnect()
    this.controls.dispose()
    this.clearGroup(this.structureGroup)
    this.clearGroup(this.surfaceGroup)
    this.clearGroup(this.centreLineGroup)
    this.clearGroup(this.sphereGroup)
    for (const d of this.disposables) {
      try { d.dispose() } catch { /* noop */ }
    }
    this.disposables = []
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
