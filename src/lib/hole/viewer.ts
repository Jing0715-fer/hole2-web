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
  parsePDB, computeBonds, elementInfo, isProtein, isNucleic, isWater,
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
    showBallStick: true,
    showSurface: true,
    showSpheres: false,
    showCentreLine: true,
    surfaceOpacity: 0.85,
    sphereScale: 1.0,
  }
  // atom colour array for ball-stick (CPK)
  private atomColors: Float32Array = new Float32Array(0)
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

  /** Load a PDB structure (text) and render cartoon + ball-and-stick. */
  loadStructure(pdbText: string) {
    // dispose existing structure
    this.clearGroup(this.structureGroup)
    this.structure = parsePDB(pdbText)
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

    // 1) cartoon ribbons (protein) + nucleic backbone tubes
    if (this.options.showCartoon) {
      this.buildCartoon(s, chainColorMap)
    }

    // 2) ball-and-stick (hetero atoms + ligands; optionally all atoms)
    if (this.options.showBallStick) {
      this.buildBallStick(s)
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
    // For each polymer chain, build a tube through the CA atoms (protein) or
    // P atoms (nucleic).  Coloured per-chain.  A proper cartoon ribbon
    // (helix/sheet) needs DSSP; here we use a smooth Catmull-Rom tube which
    // reads well for most structures and is robust to missing SS records.
    for (const chain of s.chains) {
      if (!chain.polymer) continue
      const points: THREE.Vector3[] = []
      for (const ri of chain.residueIdx) {
        const r = s.residues[ri]
        // find CA for protein, P for nucleic, else first heavy atom
        let anchor = -1
        for (let i = r.start; i < r.end; i++) {
          const name = s.atoms[i].name.toUpperCase()
          if (isProtein(r.resName) && name === 'CA') { anchor = i; break }
          if (isNucleic(r.resName) && (name === 'P' || name === "O5'")) { anchor = i; break }
        }
        if (anchor < 0) {
          // fall back to first non-H atom
          for (let i = r.start; i < r.end; i++) {
            if (s.atoms[i].element !== 'H') { anchor = i; break }
          }
        }
        if (anchor >= 0) {
          const a = s.atoms[anchor]
          points.push(new THREE.Vector3(a.x, a.y, a.z))
        }
      }
      if (points.length < 2) continue
      // chain break detection: if two consecutive points are > 8 Å apart,
      // split into multiple tubes.
      const segments: THREE.Vector3[][] = [[points[0]]]
      for (let i = 1; i < points.length; i++) {
        if (points[i].distanceTo(points[i - 1]) > 8.0) {
          segments.push([points[i]])
        } else {
          segments[segments.length - 1].push(points[i])
        }
      }
      const col = chainColorMap.get(chain.id) ?? 0x10b981
      for (const seg of segments) {
        if (seg.length < 2) continue
        const curve = new THREE.CatmullRomCurve3(seg, false, 'catmullrom', 0.5)
        const tubeGeo = new THREE.TubeGeometry(curve, Math.max(8, seg.length * 4), 0.35, 8, false)
        const mat = new THREE.MeshStandardMaterial({
          color: col, roughness: 0.45, metalness: 0.05,
        })
        const mesh = new THREE.Mesh(tubeGeo, mat)
        this.structureGroup.add(mesh)
        this.disposables.push(tubeGeo, mat)
      }
    }
  }

  private buildBallStick(s: PdbStructure) {
    // pick atoms: all hetero + water O, plus the first N atoms of each chain
    // (cap so the scene does not get too heavy for large structures)
    const MAX_ATOMS = 8000
    const atomIdx: number[] = []
    for (let i = 0; i < s.atoms.length; i++) {
      const a = s.atoms[i]
      if (a.hetero) { atomIdx.push(i); continue }
      // for polymer atoms, show only backbone + sidechain heavy atoms
      // but cap total to MAX_ATOMS to keep performance sane
      if (atomIdx.length < MAX_ATOMS) atomIdx.push(i)
    }

    // build per-atom colour array (CPK)
    this.atomColors = new Float32Array(s.atoms.length * 3)
    for (let i = 0; i < s.atoms.length; i++) {
      const el = s.atoms[i].element
      const info = elementInfo(el)
      this.atomColors[i * 3] = info.color[0]
      this.atomColors[i * 3 + 1] = info.color[1]
      this.atomColors[i * 3 + 2] = info.color[2]
    }

    // atom spheres — InstancedMesh of unit spheres scaled per atom
    if (atomIdx.length > 0) {
      const sphereGeo = new THREE.SphereGeometry(1, 16, 12)
      const sphereMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
      const inst = new THREE.InstancedMesh(sphereGeo, sphereMat, atomIdx.length)
      const m = new THREE.Matrix4()
      const color = new THREE.Color()
      const scale = this.options.sphereScale
      for (let k = 0; k < atomIdx.length; k++) {
        const i = atomIdx[k]
        const a = s.atoms[i]
        const r = a.hetero ? elementInfo(a.element).vdw * 0.45 : 0.28
        m.makeScale(r * scale, r * scale, r * scale)
        m.setPosition(a.x, a.y, a.z)
        inst.setMatrixAt(k, m)
        color.setRGB(this.atomColors[i * 3], this.atomColors[i * 3 + 1], this.atomColors[i * 3 + 2])
        inst.setColorAt(k, color)
      }
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      this.structureGroup.add(inst)
      this.disposables.push(sphereGeo, sphereMat)
    }

    // bonds — half-bond-coloured cylinders
    const bonds = computeBonds(s)
    if (bonds.length > 0) {
      const cylGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 8, 1, true)
      const cylMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.0 })
      const inst = new THREE.InstancedMesh(cylGeo, cylMat, bonds.length * 2)
      const m = new THREE.Matrix4()
      const color = new THREE.Color()
      const up = new THREE.Vector3(0, 1, 0)
      const a = new THREE.Vector3()
      const b = new THREE.Vector3()
      const mid = new THREE.Vector3()
      const quat = new THREE.Quaternion()
      for (let k = 0; k < bonds.length; k++) {
        const [i, j] = bonds[k]
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
        color.setRGB(this.atomColors[i * 3], this.atomColors[i * 3 + 1], this.atomColors[i * 3 + 2])
        inst.setColorAt(k * 2, color)
        // second half
        const half2 = mid.clone().lerp(b, 0.5)
        const len2 = mid.distanceTo(b)
        const dir2 = b.clone().sub(mid).normalize()
        quat.setFromUnitVectors(up, dir2)
        m.compose(half2, quat, new THREE.Vector3(1, len2, 1))
        inst.setMatrixAt(k * 2 + 1, m)
        color.setRGB(this.atomColors[j * 3], this.atomColors[j * 3 + 1], this.atomColors[j * 3 + 2])
        inst.setColorAt(k * 2 + 1, color)
      }
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      this.structureGroup.add(inst)
      this.disposables.push(cylGeo, cylMat)
    }
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
    this.updateVisibility()
  }

  private updateVisibility() {
    this.structureGroup.visible = this.options.showCartoon || this.options.showBallStick
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
