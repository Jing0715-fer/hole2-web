/**
 * Minimal PDB parser — inspired by MolVision's parser.ts (MIT, Jing0715-fer)
 * but trimmed to just what the HOLE2 web viewer needs: atom positions,
 * element colours and residue/chain grouping for cartoon + ball-stick.
 *
 * PDB columns (1-based, from the format spec):
 *   1-6   record name   "ATOM  " / "HETATM"
 *   7-11  atom serial
 *   13-16 atom name
 *   17    altLoc
 *   18-20 residue name
 *   22    chainID
 *   23-26 residue sequence number
 *   27    insertion code
 *   31-38 x
 *   39-46 y
 *   47-54 z
 *   55-60 occupancy
 *   61-66 B-factor
 *   77-78 element symbol (right-justified)
 */

export interface PdbAtom {
  serial: number
  name: string
  element: string
  resName: string
  chainId: string
  resSeq: number
  hetero: boolean
  x: number
  y: number
  z: number
  bfactor: number
  occupancy: number
}

export interface PdbResidue {
  chainId: string
  resSeq: number
  resName: string
  hetero: boolean
  start: number // atom index (inclusive)
  end: number   // atom index (exclusive)
}

export interface PdbChain {
  id: string
  polymer: boolean
  residueIdx: number[]
}

export interface PdbStructure {
  atoms: PdbAtom[]
  residues: PdbResidue[]
  chains: PdbChain[]
  title: string
}

const PROTEIN_3TO1: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
  THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
}

const NUCLEIC = new Set(['DA', 'DC', 'DG', 'DT', 'DU', 'A', 'C', 'G', 'T', 'U'])
const WATERS = new Set(['HOH', 'WAT', 'TIP', 'TIP3', 'TIP4', 'DOD', 'H2O', 'SOL', 'W'])

export function isProtein(resName: string): boolean {
  return resName in PROTEIN_3TO1
}
export function isNucleic(resName: string): boolean {
  return NUCLEIC.has(resName.toUpperCase())
}
export function isWater(resName: string): boolean {
  return WATERS.has(resName.toUpperCase())
}

/** Element table — vdw radius + CPK colour. */
export interface ElementInfo {
  element: string
  vdw: number   // Å
  color: [number, number, number] // 0..1 linear
}

const ELEMENT_TABLE: Record<string, ElementInfo> = {
  H:  { element: 'H',  vdw: 1.20, color: [0.95, 0.95, 0.95] },
  HE: { element: 'HE', vdw: 1.40, color: [0.85, 1.00, 1.00] },
  LI: { element: 'LI', vdw: 1.82, color: [0.80, 0.50, 1.00] },
  C:  { element: 'C',  vdw: 1.70, color: [0.40, 0.40, 0.40] },
  N:  { element: 'N',  vdw: 1.55, color: [0.20, 0.40, 1.00] },
  O:  { element: 'O',  vdw: 1.52, color: [1.00, 0.20, 0.20] },
  F:  { element: 'F',  vdw: 1.47, color: [0.50, 1.00, 0.30] },
  NA: { element: 'NA', vdw: 2.27, color: [0.70, 0.40, 1.00] },
  MG: { element: 'MG', vdw: 1.73, color: [0.40, 0.70, 1.00] },
  P:  { element: 'P',  vdw: 1.80, color: [1.00, 0.65, 0.00] },
  S:  { element: 'S',  vdw: 1.80, color: [1.00, 1.00, 0.20] },
  CL: { element: 'CL', vdw: 1.75, color: [0.40, 1.00, 0.40] },
  K:  { element: 'K',  vdw: 2.75, color: [0.70, 0.30, 0.90] },
  CA: { element: 'CA', vdw: 2.31, color: [0.50, 0.50, 0.70] },
  FE: { element: 'FE', vdw: 2.04, color: [1.00, 0.48, 0.30] },
  ZN: { element: 'ZN', vdw: 2.10, color: [0.50, 0.70, 0.70] },
  CU: { element: 'CU', vdw: 1.40, color: [0.80, 0.50, 0.20] },
  MN: { element: 'MN', vdw: 2.05, color: [0.60, 0.40, 0.40] },
  I:  { element: 'I',  vdw: 1.98, color: [0.50, 0.20, 0.70] },
  BR: { element: 'BR', vdw: 1.85, color: [0.55, 0.20, 0.10] },
  B:  { element: 'B',  vdw: 1.92, color: [1.00, 0.85, 0.50] },
}

export function elementInfo(symbol: string): ElementInfo {
  const key = symbol.toUpperCase().trim()
  return ELEMENT_TABLE[key] ?? { element: symbol, vdw: 1.70, color: [1.00, 0.20, 0.80] }
}

/** Best-effort element guess from an atom name (when columns 77-78 are empty). */
export function elementFromAtomName(name: string, resName: string): string {
  const n = name.trim().toUpperCase()
  // PDB atom-name convention: first two chars are the element (right-justified)
  // but most files just put C/N/O first.  Handle the common cases.
  if (/^\d*[CHNOSP]\b/.test(n) || /^[CHNOSP]$/.test(n)) return n[0]
  if (n.length >= 2 && /^[A-Z]{2}/.test(n)) {
    const two = n.substring(0, 2)
    if (two in ELEMENT_TABLE) return two
  }
  // Metals often show up as 2-letter codes
  if (n in ELEMENT_TABLE) return n
  // Single letter fallback
  return n.charAt(0)
}

/** Parse a PDB text file into a PdbStructure. */
export function parsePDB(text: string): PdbStructure {
  const atoms: PdbAtom[] = []
  const residues: PdbResidue[] = []
  let title = ''
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith('HEADER')) {
      const t = line.substring(10, 50).trim()
      if (t) title = t
      continue
    }
    if (line.startsWith('TITLE')) {
      const t = line.substring(10).trim()
      if (t) title = (title ? title + ' ' : '') + t
      continue
    }
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue
    // Some malformed PDBs have short lines — guard.
    if (line.length < 54) continue
    const record = line.substring(0, 6).trim()
    const serial = parseInt(line.substring(6, 11).trim(), 10)
    const name = line.substring(12, 16).trim()
    const resName = line.substring(17, 20).trim()
    const chainId = line.substring(21, 22).trim() || 'A'
    const resSeq = parseInt(line.substring(22, 26).trim(), 10)
    const x = parseFloat(line.substring(30, 38))
    const y = parseFloat(line.substring(38, 46))
    const z = parseFloat(line.substring(46, 54))
    let bfactor = 0
    if (line.length >= 66) bfactor = parseFloat(line.substring(60, 66)) || 0
    let occ = 1.0
    if (line.length >= 60) occ = parseFloat(line.substring(54, 60)) || 1.0
    let element = ''
    if (line.length >= 78) element = line.substring(76, 78).trim()
    if (!element) element = elementFromAtomName(name, resName)
    atoms.push({
      serial: isNaN(serial) ? atoms.length + 1 : serial,
      name, element, resName, chainId, resSeq,
      hetero: record === 'HETATM',
      x, y, z, bfactor, occupancy: occ,
    })
  }
  // Group atoms into residues
  let cur: PdbResidue | null = null
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]
    if (!cur || cur.chainId !== a.chainId || cur.resSeq !== a.resSeq || cur.resName !== a.resName || cur.hetero !== a.hetero) {
      if (cur) cur.end = i
      cur = { chainId: a.chainId, resSeq: a.resSeq, resName: a.resName, hetero: a.hetero, start: i, end: i }
      residues.push(cur)
    }
  }
  if (cur) cur.end = atoms.length
  // Group residues into chains (preserve order, merge by chainId + polymer/het status)
  const chains: PdbChain[] = []
  let curChain: PdbChain | null = null
  for (let i = 0; i < residues.length; i++) {
    const r = residues[i]
    const polymer = !r.hetero && (isProtein(r.resName) || isNucleic(r.resName))
    const sameKind = curChain && curChain.id === r.chainId && !!curChain.polymer === polymer
    if (!curChain || !sameKind) {
      curChain = { id: r.chainId, polymer, residueIdx: [] }
      chains.push(curChain)
    }
    curChain.residueIdx.push(i)
  }
  return { atoms, residues, chains, title }
}

/** Compute bonds by distance (1.0–1.9 Å for covalent).  O(n²) but capped. */
export function computeBonds(structure: PdbStructure, maxBonds = 50000): [number, number][] {
  const atoms = structure.atoms
  const n = atoms.length
  const bonds: [number, number][] = []
  // For large structures, use a spatial hash to avoid O(n²) blowup
  if (n > 5000) return computeBondsHashed(structure, maxBonds)
  for (let i = 0; i < n; i++) {
    const ai = atoms[i]
    for (let j = i + 1; j < n; j++) {
      const aj = atoms[j]
      if (ai.chainId !== aj.chainId && !ai.hetero && !aj.hetero) continue
      const dx = ai.x - aj.x, dy = ai.y - aj.y, dz = ai.z - aj.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < 1.0 || d2 > 3.61) continue // 1.0..1.9 Å
      // exclude same-residue non-bonded (e.g. water O-H already covered)
      if (ai.resSeq === aj.resSeq && ai.chainId === aj.chainId) {
        // bond only if both are heavy atoms within reasonable distance
        if (ai.element === 'H' && aj.element === 'H') continue
      }
      bonds.push([i, j])
      if (bonds.length >= maxBonds) return bonds
    }
  }
  return bonds
}

function computeBondsHashed(structure: PdbStructure, maxBonds: number): [number, number][] {
  const atoms = structure.atoms
  const n = atoms.length
  const cellSize = 2.5
  const map = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const a = atoms[i]
    const cx = Math.floor(a.x / cellSize)
    const cy = Math.floor(a.y / cellSize)
    const cz = Math.floor(a.z / cellSize)
    const key = `${cx},${cy},${cz}`
    let arr = map.get(key)
    if (!arr) { arr = []; map.set(key, arr) }
    arr.push(i)
  }
  const bonds: [number, number][] = []
  const offsets = [-1, 0, 1]
  for (let i = 0; i < n; i++) {
    const a = atoms[i]
    const cx = Math.floor(a.x / cellSize)
    const cy = Math.floor(a.y / cellSize)
    const cz = Math.floor(a.z / cellSize)
    for (const ox of offsets) for (const oy of offsets) for (const oz of offsets) {
      const arr = map.get(`${cx + ox},${cy + oy},${cz + oz}`)
      if (!arr) continue
      for (const j of arr) {
        if (j <= i) continue
        const b = atoms[j]
        if (a.chainId !== b.chainId && !a.hetero && !b.hetero) continue
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 1.0 || d2 > 3.61) continue
        if (a.resSeq === b.resSeq && a.chainId === b.chainId && a.element === 'H' && b.element === 'H') continue
        bonds.push([i, j])
        if (bonds.length >= maxBonds) return bonds
      }
    }
  }
  return bonds
}
