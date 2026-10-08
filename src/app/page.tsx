'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Github, ArrowRight, Upload, Activity, Route, BoxSelect,
  Loader2, Crosshair,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { RunForm } from '@/components/hole/RunForm'
import { Viewer3D } from '@/components/hole/Viewer3D'
import { ViewerControls } from '@/components/hole/ViewerControls'
import { ProfileChart } from '@/components/hole/ProfileChart'
import { ResultsPanel } from '@/components/hole/ResultsPanel'
import { HistoryPanel } from '@/components/hole/HistoryPanel'
import { CaverRunForm } from '@/components/caver/CaverRunForm'
import { CaverResultsPanel } from '@/components/caver/CaverResultsPanel'
import { SectionLabel } from '@/components/hole/SectionLabel'
import { DEFAULT_PARAMS, type RunParams, type RunResult, type HoleSphere, type HoleSurface } from '@/lib/hole/types'
import type { HoleViewerOptions } from '@/components/hole/Viewer3D'
import {
  fetchHealth, fetchRadSets, fetchExamples, runHole, fetchPdbId,
  type ExampleInfo, type RadSetInfo,
} from '@/lib/hole/api'
import { loadHistory, addToHistory, removeFromHistory, clearHistory, type HistoryEntry } from '@/lib/hole/history'
import { DEFAULT_CAVER_PARAMS, type CaverParams, type CaverResult, CAVER_CLUSTER_COLORS } from '@/lib/caver/types'
import { runCaverAnalysis } from '@/lib/caver/api'
import { cn } from '@/lib/utils'

type AnalysisMode = 'hole' | 'caver'

const EMPTY_SURFACE: HoleSurface = { triangles: [], colors: [] }

/** Instrument-canvas ground — must match the renderer clear colour. */
const CANVAS_BG = '#0c0e11'

type EngineState = 'checking' | 'ready' | 'offline'

/** Corner registration mark — like a camera viewfinder / instrument bezel. */
function CornerTick({ className }: { className: string }) {
  return <span aria-hidden className={cn('pointer-events-none absolute size-3.5 border-canvas-foreground/25', className)} />
}

export default function Home() {
  // run form state
  const [params, setParams] = useState<RunParams>(DEFAULT_PARAMS)
  const [pdbFile, setPdbFile] = useState<File | null>(null)
  const [pdbName, setPdbName] = useState('')
  const [pdbText, setPdbText] = useState<string | null>(null)
  const [customRad, setCustomRad] = useState<File | null>(null)
  const [fetchingPdb, setFetchingPdb] = useState(false)

  // backend metadata
  const [radSets, setRadSets] = useState<RadSetInfo>({ rad_sets: [{ name: 'simple', description: 'Simple AMBER vdw radii' }], default: 'simple' })
  const [examples, setExamples] = useState<ExampleInfo[]>([])
  const [serviceReady, setServiceReady] = useState<boolean | null>(null)

  // run state
  const [running, setRunning] = useState(false)
  const [runElapsed, setRunElapsed] = useState(0)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // history state
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())

  // drag-and-drop onto the viewer canvas
  const [dragOverViewer, setDragOverViewer] = useState(false)

  // viewer state
  const [viewerOpts, setViewerOpts] = useState<HoleViewerOptions>({
    showCartoon: true,
    showBallStick: false,
    showSurface: true,
    showSpheres: false,
    showCentreLine: true,
    showPoreSideChains: true,
    showTunnels: true,
    surfaceOpacity: 1.0,
    sphereScale: 1.0,
  })
  const viewerRef = useRef<{ capturePNG: () => string; highlightPorePosition?: (t: number | null) => void } | null>(null)

  // Analysis mode: HOLE2 (pore profile) or CAVER (access tunnels)
  const [mode, setMode] = useState<AnalysisMode>('hole')

  // CAVER state
  const [caverParams, setCaverParams] = useState<CaverParams>(DEFAULT_CAVER_PARAMS)
  const [caverResult, setCaverResult] = useState<CaverResult | null>(null)
  const [caverError, setCaverError] = useState<string | null>(null)
  const [caverRunning, setCaverRunning] = useState(false)
  const [pickMode, setPickMode] = useState(false)

  // Fetch backend metadata on mount — retry every 3s until the service is ready
  // Also load run history from localStorage
  useEffect(() => {
    setHistory(loadHistory())
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout>
    let attempt = 0

    const check = async () => {
      if (cancelled) return
      attempt++
      try {
        const h = await fetchHealth()
        if (cancelled) return
        if (h.env_ready) {
          setServiceReady(true)
          fetchRadSets().then((r: RadSetInfo) => setRadSets(r)).catch(() => {})
          fetchExamples().then(setExamples).catch(() => {})
        } else {
          setServiceReady(false)
          if (attempt < 20) retryTimer = setTimeout(check, 3000)
        }
      } catch {
        if (cancelled) return
        setServiceReady(false)
        if (attempt < 20) retryTimer = setTimeout(check, 3000)
      }
    }
    check()

    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [])

  // Load PDB/CIF text into the viewer when a new file is picked
  useEffect(() => {
    if (!pdbFile) { setPdbText(null); return }
    const reader = new FileReader()
    reader.onload = () => setPdbText(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => toast.error('Could not read structure file')
    reader.readAsText(pdbFile)
  }, [pdbFile])

  // Atom count for the viewer readout
  const atomCount = useMemo(() => {
    if (!pdbText) return 0
    let n = 0
    for (let i = 0; i < pdbText.length; ) {
      const j = pdbText.indexOf('\n', i)
      const line = pdbText.slice(i, j === -1 ? undefined : j)
      if (line.startsWith('ATOM') || line.startsWith('HETATM')) n++
      if (j === -1) break
      i = j + 1
    }
    return n
  }, [pdbText])

  // Run stopwatch — ticks for either HOLE2 (running) or CAVER (caverRunning)
  useEffect(() => {
    if (!running && !caverRunning) return
    const start = Date.now()
    setRunElapsed(0)
    const t = setInterval(() => setRunElapsed((Date.now() - start) / 1000), 100)
    return () => clearInterval(t)
  }, [running, caverRunning])

  const handlePickExample = useCallback(async (ex: ExampleInfo, pdb: string) => {
    try {
      toast.info(`Loading example ${ex.id}…`)
      const r = await fetch(`/api/example/${ex.id}/${pdb}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const file = new File([blob], pdb, { type: 'chemical/x-pdb' })
      setPdbFile(file)
      setPdbName(pdb)
      // Apply the example's recommended parameters (served by the backend
      // in /api/examples). Falls back to the historical hard-coded params
      // for the three original HOLE2 examples when the server omits them.
      const next = { ...DEFAULT_PARAMS }
      const p = (ex as ExampleInfo & { params?: Record<string, string | boolean> }).params
      if (p && typeof p === 'object' && Object.keys(p).length > 0) {
        for (const [k, v] of Object.entries(p)) {
          if (k in next) (next as Record<string, unknown>)[k] = typeof v === 'boolean' ? v : String(v)
        }
      } else if (ex.id.includes('gramicidin')) {
        next.endrad = '5.0'
        next.shorto = '0'  // full output so the profile is parsed
        next.dotden = '20'
      } else if (ex.id.includes('choleratoxin')) {
        next.connolly = true
        next.ignore_residues = 'HOH TIP WAT'
        next.shorto = '0'
        next.dotden = '5'
        next.endrad = '15.0'
      } else if (ex.id.includes('maltoporin')) {
        next.cvect_x = '0.0'; next.cvect_y = '0.0'; next.cvect_z = '1.0'
        next.cpoint_x = '-14.285'; next.cpoint_y = '47.809'; next.cpoint_z = '82.707'
        next.ignore_residues = 'FRU GLC MG HOH'
        next.shorto = '0'
        next.dotden = '20'
      }
      setParams(next)
      toast.success(`Loaded ${pdb} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`)
    } catch (e) {
      toast.error('Failed to load example: ' + (e as Error).message)
    }
  }, [])

  const handleRun = useCallback(async () => {
    if (!pdbFile) { toast.error('Load a structure first — upload, fetch by ID, or pick an example.'); return }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await runHole(pdbFile, pdbName || 'input.pdb', params, customRad)
      setResult(res)
      if (res.error || res.summary?.status === 'no_pore' || res.summary?.status === 'error') {
        toast.error(res.error || 'HOLE2 could not trace a pore — see the readout for guidance.')
      } else {
        toast.success(`min radius ${res.summary.min_radius?.toFixed(3) ?? '—'} Å · ${res.summary.n_triangles} surface triangles`)
        if (res.profile && res.summary) {
          setHistory(prev => addToHistory(prev, {
            id: res.job_id + '_' + Date.now(),
            pdbName: pdbName || 'input.pdb',
            params,
            profile: res.profile,
            summary: res.summary,
          }))
        }
      }
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }, [pdbFile, pdbName, params, customRad])

  const handleReset = useCallback(() => {
    setParams(DEFAULT_PARAMS)
    setPdbFile(null); setPdbName(''); setPdbText(null)
    setCustomRad(null)
    setResult(null); setError(null)
    setCaverResult(null); setCaverError(null)
    setCaverParams(DEFAULT_CAVER_PARAMS)
  }, [])

  // CAVER run handler
  const handleCaverRun = useCallback(async () => {
    if (!pdbFile) { toast.error('Please upload or select a PDB structure first.'); return }
    setCaverRunning(true)
    setCaverError(null)
    setCaverResult(null)
    try {
      const res = await runCaverAnalysis(pdbFile, pdbName || 'input.pdb', caverParams)
      setCaverResult(res)
      if (res.error || res.tunnels.length === 0) {
        toast.error(res.error || 'CAVER found no tunnels — try adjusting the starting point or probe radius.')
      } else {
        toast.success(`CAVER done: ${res.summary.n_tunnels} tunnels in ${res.summary.n_clusters} clusters`)
      }
    } catch (e) {
      setCaverError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setCaverRunning(false)
    }
  }, [pdbFile, pdbName, caverParams])

  // Listen for "pick starting point" requests from either form.
  // `target` is 'caver' (CAVER start point) or 'hole-cpoint' (HOLE2 CPOINT).
  const [pickTarget, setPickTarget] = useState<'caver' | 'hole-cpoint' | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent
      const active = ce.detail?.active ?? false
      const target = ce.detail?.target as 'caver' | 'hole-cpoint' | undefined
      if (active && target) {
        setPickMode(true)
        setPickTarget(target)
      } else {
        setPickMode(false)
        setPickTarget(null)
      }
    }
    window.addEventListener('pick-point-start', handler)
    return () => window.removeEventListener('pick-point-start', handler)
  }, [])

  // When pick mode is active, clicking on the 3D viewer picks a point.
  // The viewer's raycaster finds the closest mesh intersection; we then
  // update the correct params (CAVER start or HOLE2 cpoint) based on
  // which form initiated the pick.
  useEffect(() => {
    if (!pickMode || !pickTarget) return
    const handleViewerClick = (e: MouseEvent) => {
      const viewer = viewerRef.current as any
      if (!viewer) return
      try {
        const hit = (viewer as any).raycastFromMouse?.(e)
        if (hit?.point) {
          const { x, y, z } = hit.point
          const xs = x.toFixed(2), ys = y.toFixed(2), zs = z.toFixed(2)
          if (pickTarget === 'caver') {
            setCaverParams(prev => ({
              ...prev,
              start_x: xs, start_y: ys, start_z: zs,
            }))
          } else if (pickTarget === 'hole-cpoint') {
            setParams(prev => ({
              ...prev,
              cpoint_x: xs, cpoint_y: ys, cpoint_z: zs,
            }))
          }
          // Notify the form that the pick is done so it can reset its button
          window.dispatchEvent(new CustomEvent('pick-point-done', {
            detail: { x, y, z, target: pickTarget },
          }))
          setPickMode(false)
          setPickTarget(null)
          const label = pickTarget === 'caver' ? 'Starting point' : 'CPOINT'
          toast.success(`${label} set to (${xs}, ${ys}, ${zs})`)
        }
      } catch { /* ignore */ }
    }
    const canvas = document.querySelector('canvas')
    canvas?.addEventListener('click', handleViewerClick)
    return () => canvas?.removeEventListener('click', handleViewerClick)
  }, [pickMode, pickTarget])

  // Fetch a structure from RCSB by its 4-character PDB ID.
  const handleFetchPdbId = useCallback(async (pdbId: string) => {
    setFetchingPdb(true)
    try {
      const res = await fetchPdbId(pdbId)
      const file = new File([res.content], res.filename, { type: 'text/plain' })
      setPdbFile(file)
      setPdbName(res.filename)
      toast.success(`Fetched ${res.pdb_id.toUpperCase()}.${res.format} (${(res.size / 1024).toFixed(1)} KB)`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setFetchingPdb(false)
    }
  }, [])

  // ⌘/Ctrl + Enter runs the analysis — dispatches to the active mode's handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (pdbFile && !running && !caverRunning) {
          if (mode === 'hole') handleRun()
          else handleCaverRun()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pdbFile, running, caverRunning, mode, handleRun, handleCaverRun])

  const spheres: HoleSphere[] = useMemo(() => result?.spheres ?? [], [result])
  const surface: HoleSurface = useMemo(() => result?.surface ?? EMPTY_SURFACE, [result])
  const centreline = useMemo(() => result?.centreline ?? [], [result])
  const profile = useMemo(() => result?.profile, [result])

  const handleCapturePNG = useCallback(() => {
    const v = viewerRef.current
    if (!v) return
    const dataUrl = v.capturePNG()
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `hole2-3d-${Date.now()}.png`
    a.click()
    toast.success('PNG snapshot saved')
  }, [])

  // History handlers
  const handleToggleHistorySelect = useCallback((id: string) => {
    setSelectedHistoryIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleRemoveHistory = useCallback((id: string) => {
    setHistory(prev => removeFromHistory(prev, id))
    setSelectedHistoryIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleClearHistory = useCallback(() => {
    setHistory(clearHistory())
    setSelectedHistoryIds(new Set())
    toast.success('History cleared')
  }, [])

  // Drop a structure file onto the viewer canvas
  const handleViewerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOverViewer(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    if (!/\.(pdb|ent|cif|mcif|txt)$/i.test(f.name)) {
      toast.error('Expected a .pdb or .cif structure file')
      return
    }
    setPdbFile(f)
    setPdbName(f.name)
    toast.success(`Loaded ${f.name}`)
  }, [])

  const engine: EngineState = serviceReady === null ? 'checking' : serviceReady ? 'ready' : 'offline'

  return (
    <div className="flex min-h-dvh flex-col bg-background lg:h-dvh lg:overflow-hidden">
      {/* Header — flat hairline bar */}
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-4 border-b bg-card px-4 sm:px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="font-display text-[26px] italic leading-none tracking-tight text-foreground">
            HOLE<span className="text-vermilion">2</span>
          </h1>
          <span aria-hidden className="hidden h-4 w-px self-center bg-border sm:block" />
          <p className="protocol-label hidden truncate sm:block">
            Pore-dimension analysis · ion channels
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div
            className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden
              className={cn(
                'size-[6px] shrink-0',
                engine === 'ready' ? 'bg-foreground' : 'bg-vermilion animate-pulse',
              )}
            />
            <span className="hidden sm:inline">{engine === 'ready' ? 'engine ready' : engine === 'checking' ? 'checking engine' : 'engine offline'}</span>
          </div>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70 sm:inline">
            fortran core 2.3.1
          </span>
          <a
            href="https://github.com/osmart/hole2"
            target="_blank"
            rel="noreferrer"
            aria-label="HOLE2 on GitHub"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <Github className="size-4" />
          </a>
        </div>
      </header>

      {/* Workbench */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(280px,320px)]">
        {/* Left rail — protocol form */}
        <div className="flex min-h-0 min-w-0 flex-col border-b lg:border-b-0 lg:border-r">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
            {/* Mode switcher — HOLE2 (pore profile) · CAVER (access tunnels) */}
            <div className="mb-4 grid grid-cols-2 border border-border bg-card">
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center gap-1.5 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors',
                  mode === 'hole' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setMode('hole')}
                aria-pressed={mode === 'hole'}
              >
                <Activity className="size-3" /> HOLE2
              </button>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center gap-1.5 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors',
                  mode === 'caver' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setMode('caver')}
                aria-pressed={mode === 'caver'}
              >
                <Route className="size-3" /> CAVER
              </button>
            </div>
            <p className="mb-5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
              {mode === 'hole'
                ? 'pore-dimension profile · single channel'
                : 'access-tunnel discovery · multiple pathways'}
            </p>

            {/* Pick mode banner — when either form has activated pick-in-3D */}
            {pickMode && (
              <div className="mb-4 border border-vermilion/40 bg-vermilion/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-vermilion">
                <Crosshair className="mr-1.5 inline size-3" />
                {pickTarget === 'hole-cpoint'
                  ? 'click structure to set HOLE2 CPOINT'
                  : 'click structure to set CAVER start point'}
              </div>
            )}

            {/* Form — HOLE2 or CAVER depending on mode */}
            {mode === 'hole' ? (
              <RunForm
                params={params}
                onParamsChange={setParams}
                pdbFile={pdbFile}
                pdbName={pdbName}
                onPdbFile={(f, n) => { setPdbFile(f); setPdbName(n) }}
                customRad={customRad}
                onCustomRad={setCustomRad}
                radSets={radSets}
                examples={examples}
                onPickExample={handlePickExample}
                onFetchPdbId={handleFetchPdbId}
                fetchingPdb={fetchingPdb}
                running={running}
              />
            ) : (
              <CaverRunForm
                params={caverParams}
                onParamsChange={setCaverParams}
                pdbFile={pdbFile}
                pdbName={pdbName}
                onPdbFile={(f, n) => { setPdbFile(f); setPdbName(n) }}
                onRun={handleCaverRun}
                onReset={handleReset}
                running={caverRunning}
              />
            )}
          </div>
          {/* Run action — pinned to the bottom of the rail, mode-aware */}
          <div className="shrink-0 border-t bg-card px-4 py-3 sm:px-5">
            <div className="flex gap-2">
              <Button
                className="h-10 flex-1 gap-2 font-mono text-[11px] uppercase tracking-[0.14em]"
                onClick={mode === 'hole' ? handleRun : handleCaverRun}
                disabled={(mode === 'hole' ? running : caverRunning) || !pdbFile}
              >
                {(mode === 'hole' ? running : caverRunning)
                  ? <span className="tnum">{mode === 'hole' ? 'tracing' : 'searching'} · {runElapsed.toFixed(1)}&nbsp;s</span>
                  : <>{mode === 'hole' ? 'Run HOLE2' : 'Run CAVER'} <ArrowRight className="size-3.5" /></>}
              </Button>
              <Button
                variant="outline"
                className="h-10 px-3 font-mono text-[11px] uppercase tracking-[0.14em]"
                onClick={handleReset}
                disabled={running || caverRunning}
                title="Reset parameters and structure"
              >
                Reset
              </Button>
            </div>
            <p className="mt-2 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/80">
              {pdbFile ? '⌘ / ctrl + enter' : 'load a structure to begin'}
            </p>
          </div>
        </div>

        {/* Centre — the stage: 3D viewer + radius profile / tunnel summary */}
        <div className="flex min-h-0 min-w-0 flex-col">
          {/* 3D viewer */}
          <div
            className={cn(
              'relative min-h-[56vh] flex-1 overflow-hidden bg-canvas lg:min-h-0',
              dragOverViewer && 'outline outline-2 -outline-offset-2 outline-vermilion',
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOverViewer(true) }}
            onDragLeave={() => setDragOverViewer(false)}
            onDrop={handleViewerDrop}
          >
            <CornerTick className="left-2.5 top-2.5 border-l border-t" />
            <CornerTick className="right-2.5 top-2.5 border-r border-t" />
            <CornerTick className="bottom-2.5 left-2.5 border-b border-l" />
            <CornerTick className="bottom-2.5 right-2.5 border-b border-r" />

            {pdbText ? (
              <Viewer3D
                pdbText={pdbText}
                pdbName={pdbName}
                spheres={mode === 'hole' ? spheres : []}
                surface={mode === 'hole' ? surface : EMPTY_SURFACE}
                centreline={mode === 'hole' ? centreline : []}
                profile={mode === 'hole' ? profile : undefined}
                caverTunnels={mode === 'caver' && caverResult ? caverResult.tunnels : undefined}
                caverStartingPoint={mode === 'caver' && caverResult ? caverResult.starting_point : undefined}
                options={viewerOpts}
                bgColor={CANVAS_BG}
                onReady={(v) => { viewerRef.current = v }}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 bg-dotgrid-dark">
                {/* registration crosshair */}
                <span aria-hidden className="pointer-events-none relative size-10">
                  <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-canvas-foreground/15" />
                  <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-canvas-foreground/15" />
                </span>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-canvas-foreground/60">
                  No structure loaded
                </p>
                <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-canvas-foreground/35">
                  <Upload className="size-3" />
                  drop a .pdb / .cif here · fetch by rcsb id · or pick an example
                </p>
              </div>
            )}

            {/* top-left readout — structure + atom count */}
            <div className="pointer-events-none absolute left-4 top-3 font-mono text-[10px] uppercase tracking-[0.14em] text-canvas-foreground/75 tnum">
              {pdbName
                ? <span>{pdbName} · {atomCount.toLocaleString()} atoms</span>
                : <span>stage empty</span>}
            </div>
            {/* top-right readout — mode-aware */}
            {mode === 'hole' && profile && !running && (
              <div className="pointer-events-none absolute right-4 top-3 font-mono text-[10px] uppercase tracking-[0.14em] text-canvas-foreground/60 tnum">
                r<sub>min</sub> {profile.min_radius?.toFixed(3) ?? '—'} å · {profile.n_samples} samples
              </div>
            )}
            {mode === 'caver' && caverResult && !caverRunning && (
              <div className="pointer-events-none absolute right-4 top-3 font-mono text-[10px] uppercase tracking-[0.14em] text-canvas-foreground/60 tnum">
                {caverResult.summary.n_tunnels} tunnels · {caverResult.summary.n_clusters} clusters
              </div>
            )}

            {/* bottom-right mouse map */}
            <div className="pointer-events-none absolute bottom-3 right-4 hidden font-mono text-[9px] uppercase tracking-[0.12em] text-canvas-foreground/40 sm:block">
              left·rotate&nbsp;&nbsp;wheel·zoom&nbsp;&nbsp;right·pan
            </div>

            {/* running state — HOLE2 mode, instrument trace overlay */}
            {running && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas/72">
                <span aria-hidden className="scanline absolute left-0 right-0 h-px bg-vermilion/80" />
                <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-canvas-foreground">
                  tracing pore
                </p>
                <p className="font-mono text-[10px] text-canvas-foreground/60 tnum">
                  {runElapsed.toFixed(1)}&nbsp;s elapsed
                </p>
              </div>
            )}
            {/* running state — CAVER mode, java caver.jar trace */}
            {caverRunning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas/72">
                <span aria-hidden className="scanline absolute left-0 right-0 h-px bg-vermilion/80" />
                <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-canvas-foreground">
                  searching tunnels
                </p>
                <p className="font-mono text-[10px] text-canvas-foreground/60 tnum">
                  java caver.jar · {runElapsed.toFixed(1)}&nbsp;s elapsed
                </p>
              </div>
            )}
          </div>

          {/* Radius profile (HOLE) / tunnel summary (CAVER) */}
          <div className="flex h-[236px] shrink-0 flex-col border-t bg-card">
            <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b px-4">
              <SectionLabel className="flex-1">
                {mode === 'hole' ? 'Radius profile R(t)' : 'Tunnel bottlenecks'}
              </SectionLabel>
              {mode === 'hole' && profile && (
                <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground tnum">
                  <span>r<sub>min</sub> <b className="font-semibold text-vermilion">{profile.min_radius?.toFixed(3) ?? '—'}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>r<sub>max</sub> <b className="font-semibold text-foreground">{profile.max_radius?.toFixed(3) ?? '—'}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>length <b className="font-semibold text-foreground">{profile.pore_length?.toFixed(1) ?? '—'}</b> å</span>
                </div>
              )}
              {mode === 'caver' && caverResult && (
                <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground tnum">
                  <span>tunnels <b className="font-semibold text-foreground">{caverResult.summary.n_tunnels}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>clusters <b className="font-semibold text-foreground">{caverResult.summary.n_clusters}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>bottleneck <b className="font-semibold text-vermilion">{caverResult.summary.min_bottleneck?.toFixed(3) ?? '—'}</b> å</span>
                </div>
              )}
            </div>

            {/* body — profile chart (HOLE) or cluster bar chart (CAVER) */}
            <div className="min-h-0 flex-1 p-1">
              {mode === 'hole' ? (
                profile ? (
                  <ProfileChart profile={profile} onHover={(t) => {
                    const v = viewerRef.current
                    if (v && v.highlightPorePosition) v.highlightPorePosition(t)
                  }} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {running ? 'profile pending' : 'no profile yet'}
                    </p>
                    <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                      run HOLE2 to plot the pore-radius trace
                    </p>
                  </div>
                )
              ) : caverResult && caverResult.clusters.length > 0 ? (
                <CaverClusterChart clusters={caverResult.clusters} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1.5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    {caverRunning ? 'searching tunnels' : 'no tunnels yet'}
                  </p>
                  <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                    run CAVER to plot cluster bottlenecks
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right rail — readout, layers, history */}
        <div className="min-h-0 min-w-0 overflow-y-auto border-t px-4 py-5 [scrollbar-gutter:stable] lg:border-t-0 lg:border-l sm:px-5">
          <div className="space-y-7">
            {mode === 'hole' ? (
              <ResultsPanel result={result} loading={running} error={error} />
            ) : (
              <CaverResultsPanel result={caverResult} loading={caverRunning} error={caverError} />
            )}
            <section className="space-y-3">
              <SectionLabel>Viewer layers</SectionLabel>
              <ViewerControls
                options={viewerOpts}
                onChange={setViewerOpts}
                onCapturePNG={handleCapturePNG}
                mode={mode}
              />
            </section>
            {mode === 'hole' && (
              <HistoryPanel
                entries={history}
                selectedIds={selectedHistoryIds}
                onToggleSelect={handleToggleHistorySelect}
                onRemove={handleRemoveHistory}
                onClear={handleClearHistory}
              />
            )}
          </div>
        </div>
      </main>

      {/* Footer — citation strip */}
      <footer className="mt-auto flex h-10 shrink-0 items-center justify-between gap-4 border-t bg-card px-4 sm:px-5">
        <p className="truncate font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          O.S.&nbsp;Smart · J.&nbsp;Goodfellow · B.A.&nbsp;Wallace — <span className="normal-case">Biophys J</span> 70:1759–1766 (1996)
        </p>
        <div className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          <a
            href="https://www.holeprogram.org/"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            holeprogram.org
          </a>
          <span className="text-muted-foreground/40">·</span>
          <a
            href="https://www.caver.cz/"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            caver.cz
          </a>
          <span className="text-muted-foreground/40">·</span>
          <span className="hidden sm:inline">outputs match cli byte-for-byte</span>
        </div>
      </footer>
    </div>
  )
}

/** Inline CAVER cluster chart — shows tunnel bottleneck radius
 *  per cluster as a bar chart. */
function CaverClusterChart({ clusters }: {
  clusters: import('@/lib/caver/types').CaverClusterSummary[]
}) {
  const maxBn = Math.max(...clusters.map(c => c.max_bottleneck), 1)
  return (
    <div className="h-full overflow-y-auto">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Cluster bottleneck radii
      </p>
      <div className="space-y-2">
        {clusters.map(c => {
          const color = CAVER_CLUSTER_COLORS[(c.id - 1) % CAVER_CLUSTER_COLORS.length]
          return (
            <div key={c.id} className="space-y-0.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="size-2.5 rounded-sm" style={{ background: color }} />
                  Cluster {c.id}
                </span>
                <span className="font-mono text-muted-foreground">
                  bn={c.avg_bottleneck.toFixed(2)}Å · pri={c.priority.toFixed(2)}
                </span>
              </div>
              {/* Bottleneck bar */}
              <div className="h-3 rounded bg-muted/40">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${(c.avg_bottleneck / maxBn) * 100}%`,
                    background: color,
                    opacity: 0.7,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
