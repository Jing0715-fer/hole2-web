/**
 * HOLE2 web viewer — three.js 3D scene
 * -------------------------------------
 * Renders a PDB structure (cartoon ribbons for polymer chains + ball-and-stick
 * for ligands) together with the HOLE2 pore surface (a coloured triangle mesh
 * parsed from the .vmd_plot output) and the pore centre line.
 *
 * 3D rendering approach inspired by MolVision (MIT, Jing0715-fer).
 *
 * three.js is loaded from a CDN (see layout.tsx) as `window.THREE` so the
 * dev server doesn't need to compile the 23 MB npm package — this avoids
 * OOM crashes in the sandbox's 4 GB cgroup.
 */

// THREE + TrackballControls are loaded from CDN script tags (see layout.tsx).
function getTHREE(): any {
  if (typeof window === 'undefined') throw new Error('window not available (SSR)')
  const T = (window as any).THREE
  if (!T) throw new Error('three.js CDN script not loaded yet')
  return T
}
const THREE: any = new Proxy({} as any, {
  get(_t, prop) { return getTHREE()[prop] },
})

/** Create THREE.TrackballControls (from CDN).
 *  TrackballControls uses quaternion-based rotation — NO spherical coordinates,
 *  NO poles, NO gimbal lock. Rotates freely in all directions. */
function createControls(camera: any, domElement: HTMLElement): any {
  const T = getTHREE()
  if (!T.TrackballControls) throw new Error('TrackballControls not loaded from CDN')
  return new T.TrackballControls(camera, domElement)
}

/** Wait for three.js + TrackballControls CDN scripts to load. */
function waitForTHREE(timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (typeof window === 'undefined') return resolve()
      const T = (window as any).THREE
      if (T && T.TrackballControls) {
        resolve()
      } else if (Date.now() - start > timeout) {
        reject(new Error('Timeout waiting for three.js + TrackballControls CDN'))
      } else {
        setTimeout(check, 50)
      }
    }
    check()
  })
}

import {
  parsePDB, parseStructure, computeBonds, elementInfo, isProtein, isNucleic, isWater,
  type PdbStructure,
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
  private controls: any // THREE.OrbitControls
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
    surfaceOpacity: 1.0,
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
  // hover tooltip element
  private tooltipEl: HTMLDivElement | null = null
  // distance measurement state
  private measureStart: THREE.Vector3 | null = null
  private measureLine: THREE.Line | null = null
  private measureLabel: THREE.Sprite | null = null

  constructor(container: HTMLElement) {
    this.container = container
    const w = container.clientWidth || 800
    const h = container.clientHeight || 600

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.setClearColor(0x0a0e1a, 1)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x0a0e1a, 80, 250)

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    this.camera.position.set(0, 0, 60)

    // TrackballControls — quaternion-based, no poles, no gimbal lock.
    this.controls = createControls(this.camera, this.renderer.domElement)
    // Configure for smooth, natural rotation:
    this.controls.rotateSpeed = 2.5
    this.controls.zoomSpeed = 1.2
    this.controls.panSpeed = 0.8
    this.controls.staticMoving = false  // enable damping
    this.controls.dynamicDampingFactor = 0.15

    // Middle-click atom picking: raycaster finds the closest mesh under
    // the cursor and re-centers the orbit target to that point.
    this.renderer.domElement.addEventListener('auxclick', (e: MouseEvent) => {
      if (e.button !== 1) return // only middle button
      this.handleMiddleClick(e)
    })

    // Double-click: zoom to the atom under the cursor
    this.renderer.domElement.addEventListener('dblclick', (e: MouseEvent) => {
      this.handleDoubleClick(e)
    })

    // Mouse hover: show residue/atom info tooltip
    this.renderer.domElement.addEventListener('pointermove', (e: PointerEvent) => {
      this.handleHover(e)
    })

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

    // Create hover tooltip element (hidden by default)
    this.tooltipEl = document.createElement('div')
    this.tooltipEl.style.cssText = `
      position: absolute; pointer-events: none; z-index: 100;
      background: rgba(15, 23, 42, 0.92); color: #e2e8f0;
      padding: 6px 10px; border-radius: 6px; font-size: 12px;
      font-family: monospace; white-space: nowrap;
      border: 1px solid rgba(148, 163, 184, 0.3);
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: none;
      line-height: 1.5;
    `
    container.style.position = 'relative'
    container.appendChild(this.tooltipEl)

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
   *  The structure stays in its original coordinates so the HOLE surface
   *  (computed in the same frame) aligns perfectly.  fitView() frames it. */
  loadStructure(text: string, filename?: string) {
    // dispose existing structure
    this.clearGroup(this.structureGroup)
    const parsed = parseStructure(text, filename)
    // Do NOT center the structure — the HOLE surface + centre line are
    // computed in the same coordinate system as the PDB, so keeping the
    // structure in its original coordinates ensures the surface aligns
    // perfectly.  fitView() will frame whatever is in the scene.
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
      this.buildPoreSideChains(s, this.currentCentreline, 6.0, chainColorMap)
    }

    this.updateVisibility()
    // Defer fitView to the next animation frame so the canvas has its
    // final layout size (the container div may still be sizing when this
    // effect runs, causing the camera framing to be wrong).
    requestAnimationFrame(() => this.fitView())
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
      this.buildPoreSideChains(s, centreline, 6.0, chainColorMap)
    }

    // surface mesh — flat shaded so each triangle's vertex colour shows
    if (surface.triangles.length > 0) {
      this.buildSurfaceMesh(surface)
    }

    // centre line — tube along the sphere centres. Always built (cheap) so
    // the "Centre line" toggle can turn it on/off after the results arrive
    // (updateVisibility flips .visible on the group).
    if (centreline.length > 1) {
      this.buildCentreLine(centreline)
    }

    // pore spheres — instanced spheres coloured by zone. Always built so the
    // "Sampled spheres" toggle works after the fact.
    if (spheres.length > 0) {
      this.buildSphereCloud(spheres)
    }

    this.updateVisibility()
    requestAnimationFrame(() => this.fitView())
  }

  private buildCartoon(s: PdbStructure, chainColorMap: Map<string, number>) {
    // Secondary-structure-aware cartoon:
    //   - helix residues → thick rounded tube (radius 0.5) in helix colour
    //   - sheet residues → flat ribbon in sheet colour
    //   - loop residues → medium tube (radius 0.3) in chain colour
    // SS comes from PDB HELIX/SHEET records (or mmCIF _struct_conf).
    // If the file has NO SS records (e.g. gramicidin, NMR structures), we
    // default to treating all polymer residues as helix — this gives a
    // reasonable thick tube for mostly-helical structures instead of a
    // hair-thin line.
    const noSS = !s.ssFromRecords
    for (const chain of s.chains) {
      if (!chain.polymer) continue
      // Collect backbone anchors + their SS for this chain
      const anchors: { pos: THREE.Vector3; ss: 'H' | 'E' | 'L' }[] = []
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
          // If no SS records, default to 'H' (helix) for a thicker, more
          // visible tube — most ion channels are helical.
          anchors.push({
            pos: new THREE.Vector3(a.x, a.y, a.z),
            ss: noSS ? 'H' : r.ss,
          })
        }
      }
      if (anchors.length < 2) continue

      // Detect chain breaks (consecutive CA distance > 8 Å → new segment)
      const segments: THREE.Vector3[][] = []
      let curSeg: THREE.Vector3[] = []
      for (let i = 0; i < anchors.length; i++) {
        if (i > 0 && anchors[i].pos.distanceTo(anchors[i - 1].pos) > 8.0) {
          if (curSeg.length >= 2) segments.push(curSeg)
          curSeg = []
        }
        curSeg.push(anchors[i].pos)
      }
      if (curSeg.length >= 2) segments.push(curSeg)

      const chainCol = chainColorMap.get(chain.id) ?? 0x10b981
      // For each continuous segment, build a single smooth tube through
      // all CA atoms.  We colour it based on the dominant SS type (or chain
      // colour if no SS records).
      for (const seg of segments) {
        const curve = new THREE.CatmullRomCurve3(seg, false, 'catmullrom', 0.5)
        const tubularSeg = Math.max(16, seg.length * 8)
        // Use a medium-thick tube by default — looks good for both helices
        // and loops.  Colour: helix=red, sheet=amber, loop=chain colour.
        const ss = anchors[0]?.ss ?? 'L'
        let radius = 0.8
        // Use per-chain color for ALL SS types — this makes multi-chain
        // structures (like gramicidin's A/B dimer) visually distinct
        // instead of all being the same red.
        let color = chainCol
        if (ss === 'H') { radius = 1.0 }
        else if (ss === 'E') { radius = 0.7 }
        else { radius = 0.6 }
        const tubeGeo = new THREE.TubeGeometry(curve, tubularSeg, radius, 10, false)
        const mat = new THREE.MeshStandardMaterial({
          color, roughness: 0.4, metalness: 0.05,
        })
        const mesh = new THREE.Mesh(tubeGeo, mat)
        this.structureGroup.add(mesh)
        this.disposables.push(tubeGeo, mat)
        // Add end-cap spheres at the tube termini so they look finished
        // (not cut off). This is especially important for multi-chain
        // structures like gramicidin where the two chains meet at an
        // interface — the caps make it clear the gap is biological.
        const capGeo = new THREE.SphereGeometry(radius, 12, 8)
        const capMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.05 })
        const capStart = new THREE.Mesh(capGeo, capMat)
        capStart.position.copy(seg[0])
        const capEnd = new THREE.Mesh(capGeo, capMat)
        capEnd.position.copy(seg[seg.length - 1])
        this.structureGroup.add(capStart)
        this.structureGroup.add(capEnd)
        this.disposables.push(capGeo, capMat)
      }
    }
  }

  /** Build side-chain sticks for residues whose CA is within `cutoff` Å of
   *  any pore centre-line sphere.  This shows the pore-lining residues. */
  buildPoreSideChains(s: PdbStructure, centreline: [number, number, number][], cutoff = 6.0,
                       chainColorMap?: Map<string, number>) {
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

    // Build a per-atom color array where carbon atoms get the chain color
    // (not grey CPK) and other atoms keep their CPK colors.
    const sideChainColors = new Float32Array(s.atoms.length * 3)
    for (let i = 0; i < s.atoms.length; i++) {
      const a = s.atoms[i]
      if (a.element === 'C' && chainColorMap) {
        // Carbon → chain color
        const col = chainColorMap.get(a.chainId) ?? 0x808080
        const c = new THREE.Color(col)
        sideChainColors[i * 3] = c.r
        sideChainColors[i * 3 + 1] = c.g
        sideChainColors[i * 3 + 2] = c.b
      } else {
        // Other atoms → CPK
        sideChainColors[i * 3] = this.atomColors[i * 3]
        sideChainColors[i * 3 + 1] = this.atomColors[i * 3 + 1]
        sideChainColors[i * 3 + 2] = this.atomColors[i * 3 + 2]
      }
    }
    // Build sticks + spheres with the side-chain-specific colors
    this.buildSticksForAtomsColored(s, atomIdx, 0.12, sideChainColors)
    this.buildSpheresForAtomsColored(s, atomIdx, 0.18, sideChainColors)
  }

  /** Build stick cylinders for a set of atoms, using a custom color array. */
  private buildSticksForAtomsColored(s: PdbStructure, atomIdx: number[], stickRadius: number,
                                       customColors: Float32Array) {
    const bonds = computeBonds(s)
    if (bonds.length === 0) return
    const atomSet = new Set(atomIdx)
    const relevant = bonds.filter(([a, b]) => atomSet.has(a) && atomSet.has(b))
    if (relevant.length === 0) return
    const cylGeo = new THREE.CylinderGeometry(stickRadius, stickRadius, 1, 8, 1, true)
    const cylMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.0 })
    const inst = new THREE.InstancedMesh(cylGeo, cylMat, relevant.length * 2)
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const mid = new THREE.Vector3()
    const quat = new THREE.Quaternion()
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
      color.setRGB(customColors[i * 3], customColors[i * 3 + 1], customColors[i * 3 + 2])
      inst.setColorAt(k * 2, color)
      const half2 = mid.clone().lerp(b, 0.5)
      const len2 = mid.distanceTo(b)
      const dir2 = b.clone().sub(mid).normalize()
      quat.setFromUnitVectors(up, dir2)
      m.compose(half2, quat, new THREE.Vector3(1, len2, 1))
      inst.setMatrixAt(k * 2 + 1, m)
      color.setRGB(customColors[j * 3], customColors[j * 3 + 1], customColors[j * 3 + 2])
      inst.setColorAt(k * 2 + 1, color)
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    this.structureGroup.add(inst)
    this.disposables.push(cylGeo, cylMat)
  }

  /** Build spheres for a set of atoms, using a custom color array. */
  private buildSpheresForAtomsColored(s: PdbStructure, atomIdx: number[], radius: number,
                                        customColors: Float32Array) {
    const sphereGeo = new THREE.SphereGeometry(1, 16, 12)
    const sphereMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
    const inst = new THREE.InstancedMesh(sphereGeo, sphereMat, atomIdx.length)
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    for (let k = 0; k < atomIdx.length; k++) {
      const i = atomIdx[k]
      const a = s.atoms[i]
      m.makeScale(radius, radius, radius)
      m.setPosition(a.x, a.y, a.z)
      inst.setMatrixAt(k, m)
      color.setRGB(customColors[i * 3], customColors[i * 3 + 1], customColors[i * 3 + 2])
      inst.setColorAt(k, color)
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    this.structureGroup.add(inst)
    this.disposables.push(sphereGeo, sphereMat)
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
      flatShading: true,  // recompute normals from geometry — fixes inward-facing normals from vmd_plot
      depthWrite: true,
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
    // Keep the raw data so setOptions can rescale instances live without a
    // full rebuild (the sphere-scale slider updates in real time).
    inst.userData.spheres = spheres
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

  /** Rescale the sampled-sphere InstancedMesh in place for a new scale. */
  private rescaleSphereCloud(scale: number) {
    this.sphereGroup.traverse(obj => {
      const inst = obj as any
      if (!(inst as any).isInstancedMesh || !inst.userData?.spheres) return
      const spheres: HoleSphere[] = inst.userData.spheres
      const m = new THREE.Matrix4()
      for (let k = 0; k < spheres.length; k++) {
        const s = spheres[k]
        const r = s.r * 0.5 * scale
        m.makeScale(r, r, r)
        m.setPosition(s.x, s.y, s.z)
        inst.setMatrixAt(k, m)
      }
      inst.instanceMatrix.needsUpdate = true
    })
  }

  /** Set viewer options (visibility toggles, opacity, etc.). */
  setOptions(opts: Partial<HoleViewerOptions>) {
    const prevPoreSideChains = this.options.showPoreSideChains
    const prevSphereScale = this.options.sphereScale
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
    // Sphere-scale slider — rescale the instanced spheres in place (no
    // rebuild needed).
    if (opts.sphereScale !== undefined && opts.sphereScale !== prevSphereScale) {
      this.rescaleSphereCloud(opts.sphereScale)
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
      if (this.options.showPoreSideChains) this.buildPoreSideChains(s, this.currentCentreline, 6.0, chainColorMap)
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
    // Ensure the canvas is sized correctly before framing the scene.
    this.handleResize()
    this.bbox.makeEmpty()
    let meshCount = 0
    for (const g of [this.structureGroup, this.surfaceGroup, this.centreLineGroup, this.sphereGroup]) {
      if (!g.visible) continue
      g.updateMatrixWorld(true)
      g.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          meshCount++
          const anyObj = obj as unknown as {
            isInstancedMesh?: boolean
            instanceMatrix?: { array: ArrayLike<number> }
          }
          if (anyObj.isInstancedMesh && anyObj.instanceMatrix?.array) {
            // InstancedMesh: the geometry is a unit primitive centred at the
            // origin — its bounding box says nothing about where the atoms
            // actually are.  three r128 has no InstancedMesh.computeBoundingBox,
            // so compute the box manually from the instance matrices: each
            // 4x4 (column-major) carries the per-instance scale (column
            // vector lengths) and translation (elements 12-14).  Without
            // this, structures far from the origin (e.g. raw cryo-EM frames
            // like TRPM8 at ~(210,210,200)) get framed against a phantom box
            // at 0,0,0 and the camera ends up pointing at empty space.
            obj.updateMatrixWorld(true)
            const arr = anyObj.instanceMatrix.array
            const nInst = Math.floor(arr.length / 16)
            const min = [Infinity, Infinity, Infinity]
            const max = [-Infinity, -Infinity, -Infinity]
            for (let k = 0; k < nInst; k++) {
              const o16 = k * 16
              // column vector lengths = per-axis scale
              const sx = Math.hypot(arr[o16], arr[o16 + 1], arr[o16 + 2])
              const sy = Math.hypot(arr[o16 + 4], arr[o16 + 5], arr[o16 + 6])
              const sz = Math.hypot(arr[o16 + 8], arr[o16 + 9], arr[o16 + 10])
              const px = arr[o16 + 12], py = arr[o16 + 13], pz = arr[o16 + 14]
              const rx = Math.max(sx, sy, sz), ry = rx, rz = rx
              for (let c = 0; c < 3; c++) {
                const p = c === 0 ? px : c === 1 ? py : pz
                const r = c === 0 ? rx : c === 1 ? ry : rz
                if (p - r < min[c]) min[c] = p - r
                if (p + r > max[c]) max[c] = p + r
              }
            }
            if (Number.isFinite(min[0])) {
              const bb = new THREE.Box3(
                new THREE.Vector3(min[0], min[1], min[2]),
                new THREE.Vector3(max[0], max[1], max[2]),
              )
              bb.applyMatrix4(obj.matrixWorld)
              this.bbox.union(bb)
            }
            return
          }
          const geo = obj.geometry
          if (geo && geo.attributes && geo.attributes.position) {
            geo.computeBoundingBox()
            const bb = geo.boundingBox
            if (bb) {
              obj.updateMatrixWorld(true)
              bb.applyMatrix4(obj.matrixWorld)
              this.bbox.union(bb)
            }
          }
        }
      })
    }
    if (this.bbox.isEmpty()) {
      return
    }
    const center = new THREE.Vector3()
    this.bbox.getCenter(center)
    const size = new THREE.Vector3()
    this.bbox.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const fov = this.camera.fov * Math.PI / 180
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.4
    // Scale the depth-cue fog with the camera distance so large structures
    // (e.g. the 158 Å TRPM8 pore, camera ~290 Å out) are not fully fogged
    // out — the fixed 80-250 Å range rendered them invisible against the
    // background.
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = dist * 0.9
      this.scene.fog.far = dist * 3.0
    }
    // Position the camera and let TrackballControls sync.
    // TrackballControls uses target + camera.position (same as OrbitControls).
    const dir = new THREE.Vector3(0.3, 0.2, 1).normalize()
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.camera.near = Math.max(0.01, dist / 100)
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

  /** Handle middle-click: raycast to find the closest mesh point and
   *  re-center the orbit target to that 3D position. */
  private handleMiddleClick(e: MouseEvent) {
    const hit = this.raycastFromMouse(e)
    if (hit) {
      this.controls.target.set(hit.point.x, hit.point.y, hit.point.z)
      // Also move camera to maintain the same relative offset (smooth re-center)
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
      const dist = offset.length()
      // Zoom in slightly to focus on the picked point
      const newDist = Math.min(dist, dist * 0.6)
      const dir = offset.normalize()
      this.camera.position.copy(this.controls.target).addScaledVector(dir, newDist)
    }
  }

  /** Handle double-click: zoom to the atom under the cursor */
  private handleDoubleClick(e: MouseEvent) {
    const hit = this.raycastFromMouse(e)
    if (hit) {
      this.controls.target.set(hit.point.x, hit.point.y, hit.point.z)
      // Move camera closer
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
      const dist = offset.length()
      const newDist = Math.max(5, dist * 0.3)
      const dir = offset.normalize()
      this.camera.position.copy(this.controls.target).addScaledVector(dir, newDist)
      this.controls.update()
    }
  }

  /** Handle mouse hover: show residue/atom info in a tooltip */
  private handleHover(e: PointerEvent) {
    if (!this.tooltipEl || !this.currentStructure) {
      if (this.tooltipEl) this.tooltipEl.style.display = 'none'
      return
    }

    // Don't show tooltip while dragging (TrackballControls active)
    if (this.controls && this.controls._isDragging) {
      this.tooltipEl.style.display = 'none'
      return
    }

    const hit = this.raycastFromMouse(e)
    if (!hit) {
      this.tooltipEl.style.display = 'none'
      return
    }

    // Find the nearest atom to the hit point
    const s = this.currentStructure
    let nearestIdx = -1
    let nearestDist = Infinity
    for (let i = 0; i < s.atoms.length; i++) {
      const a = s.atoms[i]
      const d2 = (a.x - hit.point.x) ** 2 + (a.y - hit.point.y) ** 2 + (a.z - hit.point.z) ** 2
      if (d2 < nearestDist) {
        nearestDist = d2
        nearestIdx = i
      }
    }

    if (nearestIdx < 0 || nearestDist > 25) { // > 5 Å away from any atom
      this.tooltipEl.style.display = 'none'
      return
    }

    const atom = s.atoms[nearestIdx]
    // Find residue info
    let resName = atom.resName
    let resSeq = atom.resSeq
    let chainId = atom.chainId
    // Format: "ALA 42  Chain A  |  CA (C)  |  xyz"
    const elementColor = this.getElementColor(atom.element)
    this.tooltipEl.innerHTML = `
      <div style="font-weight:600;color:${elementColor}">${atom.name} <span style="opacity:0.6">(${atom.element})</span></div>
      <div style="opacity:0.8">${resName} ${resSeq} · Chain ${chainId}</div>
      <div style="opacity:0.5;font-size:11px">${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)} Å</div>
    `
    this.tooltipEl.style.display = 'block'
    const rect = this.container.getBoundingClientRect()
    // Position tooltip near cursor, offset slightly
    const x = e.clientX - rect.left + 14
    const y = e.clientY - rect.top + 14
    this.tooltipEl.style.left = `${x}px`
    this.tooltipEl.style.top = `${y}px`
  }

  /** Get a CSS color string for an element */
  private getElementColor(element: string): string {
    const colors: Record<string, string> = {
      C: '#a8a8a8', N: '#3050f8', O: '#ff0d0d', S: '#ffff30',
      H: '#ffffff', P: '#ff8000', FE: '#906040', ZN: '#7d80b0',
      MG: '#8aff00', CA: '#3dff00', CL: '#1ff01f', NA: '#ab5cf2',
    }
    return colors[element.toUpperCase()] ?? '#ff80d0'
  }

  /** Raycast from mouse position to find the closest visible mesh intersection.
   *  Returns the intersection point + mesh, or null if nothing was hit. */
  private raycastFromMouse(e: MouseEvent): { point: THREE.Vector3; object: THREE.Object3D } | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)

    const meshes: THREE.Object3D[] = []
    for (const g of [this.structureGroup, this.surfaceGroup, this.centreLineGroup, this.sphereGroup]) {
      if (!g.visible) continue
      g.traverse(obj => {
        if (obj instanceof THREE.Mesh) meshes.push(obj)
      })
    }
    if (meshes.length === 0) return null

    const intersects = raycaster.intersectObjects(meshes, false)
    if (intersects.length > 0 && intersects[0].point) {
      return { point: intersects[0].point, object: intersects[0].object }
    }
    return null
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
