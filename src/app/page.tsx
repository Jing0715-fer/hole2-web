'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes, Github, ExternalLink, BookOpen, Activity, BoxSelect,
  Loader2, AlertCircle, FileDown, Route, Box as BoxIcon, Crosshair,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { RunForm } from '@/components/hole/RunForm'
import { Viewer3D } from '@/components/hole/Viewer3D'
import { ViewerControls } from '@/components/hole/ViewerControls'
import { ProfileChart } from '@/components/hole/ProfileChart'
import { ResultsPanel } from '@/components/hole/ResultsPanel'
import { HistoryPanel } from '@/components/hole/HistoryPanel'
import { CaverRunForm } from '@/components/caver/CaverRunForm'
import { CaverResultsPanel } from '@/components/caver/CaverResultsPanel'
import { DEFAULT_PARAMS, type RunParams, type RunResult, type HoleSphere, type HoleSurface } from '@/lib/hole/types'
import type { HoleViewerOptions } from '@/components/hole/Viewer3D'
import {
  fetchHealth, fetchRadSets, fetchExamples, runHole, examplePdbUrl, fetchPdbId,
  type ExampleInfo, type RadSetInfo,
} from '@/lib/hole/api'
import { loadHistory, addToHistory, removeFromHistory, clearHistory, type HistoryEntry } from '@/lib/hole/history'
import { DEFAULT_CAVER_PARAMS, type CaverParams, type CaverResult, CAVER_CLUSTER_COLORS } from '@/lib/caver/types'
import { runCaverAnalysis } from '@/lib/caver/api'

type AnalysisMode = 'hole' | 'caver'

const EMPTY_SURFACE: HoleSurface = { triangles: [], colors: [] }

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
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // history state
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())

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
          // Service is up — now fetch the metadata
          fetchRadSets().then((r: RadSetInfo) => setRadSets(r)).catch(() => {})
          fetchExamples().then(setExamples).catch(() => {})
        } else {
          setServiceReady(false)
          // Retry in 3 seconds (up to 20 attempts = 60s)
          if (attempt < 20) {
            retryTimer = setTimeout(check, 3000)
          }
        }
      } catch {
        if (cancelled) return
        setServiceReady(false)
        // Retry in 3 seconds (up to 20 attempts = 60s)
        if (attempt < 20) {
          retryTimer = setTimeout(check, 3000)
        }
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

  const handlePickExample = useCallback(async (ex: ExampleInfo, pdb: string) => {
    try {
      toast.info(`Loading example ${ex.id}…`)
      const r = await fetch(examplePdbUrl(ex.id, pdb))
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
        next.shorto = '0'  // shorto=2 suppresses the profile; keep full so we can plot it
        next.dotden = '5'  // lower density — sos_triangle overflows on this large pore at higher dotden
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
    if (!pdbFile) { toast.error('Please upload or select a PDB structure first.'); return }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await runHole(pdbFile, pdbName || 'input.pdb', params, customRad)
      setResult(res)
      if (res.error || res.summary?.status === 'no_pore' || res.summary?.status === 'error') {
        // HOLE ran but could not trace a pore (or crashed) — the warnings
        // array carries actionable hints (CVECT/CPOINT, endrad, ignore).
        toast.error(res.error || 'HOLE2 could not trace a pore — see the warnings below.')
      } else {
        toast.success(`HOLE2 done: min radius ${res.summary.min_radius?.toFixed(3) ?? '—'} Å · ${res.summary.n_triangles} surface triangles`)
        // Save to history for comparison
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
  // The Python service proxies the request (avoids CORS) and returns the
  // raw PDB or mmCIF text.
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

  // Debug handle (dev): window.__holeViewer for console diagnostics.
  useEffect(() => {
    const t = setInterval(() => {
      if (viewerRef.current) {
        (window as unknown as Record<string, unknown>).__holeViewer = viewerRef.current
        clearInterval(t)
      }
    }, 200)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-slate-50 to-slate-100 text-foreground dark:from-slate-950 dark:to-slate-900">
      {/* Toasts render via the sonner <Toaster /> mounted once in layout.tsx */}

      {/* Header — glassmorphism with gradient accent */}
      <header className="sticky top-0 z-30 border-b border-slate-200/60 bg-white/70 backdrop-blur-xl dark:border-slate-800/60 dark:bg-slate-950/70">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-4 px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
              <Boxes className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold leading-tight tracking-tight">HOLE2 Web</h1>
              <p className="truncate text-xs text-muted-foreground">Ion-channel pore-analysis studio</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={serviceReady ? 'secondary' : 'outline'}
              className="gap-2 rounded-full border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400">
              <span className={`size-2 rounded-full ${serviceReady ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-amber-500'} ${serviceReady ? '' : 'animate-pulse'}`} />
              {serviceReady === null ? 'checking…' : serviceReady ? 'Service ready' : 'offline'}
            </Badge>
            <a href="https://github.com/osmart/hole2" target="_blank" rel="noreferrer"
              className="hidden sm:inline-flex">
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                <Github className="size-3.5" /> HOLE2
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-8">
        {/* Hero */}
        <section className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <Badge variant="secondary" className="font-mono text-xs">HOLE2 2.3.1 + CAVER 3.0.3</Badge>
            <span className="text-xs text-muted-foreground/70">Smart 1996 · Chovancek 2012</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Pore & tunnel analysis studio
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Upload a structure, choose an analysis mode, and get interactive 3D visualisation +
            downloadable CLI output files. HOLE2 traces a single pore; CAVER discovers access tunnels.
          </p>

          {/* Mode switcher */}
          <div className="mt-4 inline-flex rounded-lg border border-border/60 bg-muted/30 p-1">
            <button
              className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                mode === 'hole' ? 'bg-emerald-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setMode('hole')}
            >
              <Activity className="size-3.5" /> HOLE2 · Pore profile
            </button>
            <button
              className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                mode === 'caver' ? 'bg-emerald-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setMode('caver')}
            >
              <Route className="size-3.5" /> CAVER · Access tunnels
            </button>
          </div>
          {pickMode && (
            <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-50/50 px-3 py-1.5 text-xs text-amber-600 dark:bg-amber-950/20 dark:text-amber-400">
              <Crosshair className="mr-1.5 inline size-3" />
              {pickTarget === 'hole-cpoint'
                ? 'Click on the 3D structure to set the HOLE2 channel centre point (CPOINT)'
                : 'Click on the 3D structure to set the CAVER starting point'}
            </div>
          )}
        </section>

        {/* Main 3-column grid */}
        <div className="grid gap-5 lg:grid-cols-[360px_1fr_300px]">
          {/* Left: run form — HOLE2 or CAVER depending on mode */}
          <div className="min-w-0 space-y-4">
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
                onRun={handleRun}
                onReset={handleReset}
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

          {/* Middle: 3D viewer + profile chart */}
          <div className="min-w-0 space-y-5">
            {/* 3D viewer — rounded with subtle shadow */}
            <div className="relative h-[48vh] min-h-[360px] overflow-hidden rounded-2xl border border-slate-200/60 bg-[#0a0e1a] shadow-xl shadow-slate-900/5 dark:border-slate-800/60">
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
                  bgColor="#0a0e1a"
                  onReady={(v) => { viewerRef.current = v }}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                  <div className="flex size-16 items-center justify-center rounded-2xl bg-slate-800/50">
                    <BoxSelect className="size-8 text-slate-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-400">No structure loaded</p>
                    <p className="text-xs text-slate-500">Upload a PDB/CIF, fetch by ID, or pick an example</p>
                  </div>
                </div>
              )}
              {running && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Loader2 className="size-6 animate-spin text-emerald-500" />
                    </div>
                    <p className="text-sm font-medium text-slate-200">Running HOLE2…</p>
                  </div>
                </div>
              )}
              {caverRunning && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Loader2 className="size-6 animate-spin text-emerald-500" />
                    </div>
                    <p className="text-sm font-medium text-slate-200">Searching tunnels…</p>
                  </div>
                </div>
              )}
            </div>

            {/* Pore profile chart (HOLE mode) or tunnel summary (CAVER mode) */}
            <div className="h-[28vh] min-h-[200px] rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm dark:border-slate-800/60 dark:bg-slate-900">
              {mode === 'hole' ? (
                profile ? (
                  <ProfileChart profile={profile} onHover={(t) => {
                    const v = viewerRef.current as any
                    if (v && v.highlightPorePosition) v.highlightPorePosition(t)
                  }} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <div className="flex size-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
                      <Activity className="size-6 text-slate-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">No profile yet</p>
                      <p className="text-xs text-muted-foreground/70">Run HOLE2 to see the pore-radius plot</p>
                    </div>
                  </div>
                )
              ) : caverResult && caverResult.clusters.length > 0 ? (
                <CaverClusterChart clusters={caverResult.clusters} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="flex size-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
                    <Route className="size-6 text-slate-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">No tunnels yet</p>
                    <p className="text-xs text-muted-foreground/70">Run CAVER to see access tunnels</p>
                  </div>
                </div>
              )}
            </div>

            {/* Mobile/tablet results + history */}
            <div className="lg:hidden space-y-4">
              {mode === 'hole' ? (
                <ResultsPanel result={result} loading={running} error={error} />
              ) : (
                <CaverResultsPanel result={caverResult} loading={caverRunning} error={caverError} />
              )}
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

          {/* Right: controls + results + history */}
          <div className="hidden min-w-0 space-y-4 lg:block">
            <ViewerControls
              options={viewerOpts}
              onChange={setViewerOpts}
              onCapturePNG={handleCapturePNG}
              mode={mode}
            />
            {mode === 'hole' ? (
              <ResultsPanel result={result} loading={running} error={error} />
            ) : (
              <CaverResultsPanel result={caverResult} loading={caverRunning} error={caverError} />
            )}
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

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-200/60 bg-white/50 dark:border-slate-800/60 dark:bg-slate-950/50">
        <div className="mx-auto flex max-w-[1600px] flex-col items-start justify-between gap-2 px-6 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5">
              <Activity className="size-3.5" />
              HOLE2 + CAVER web app · wrapping the original Fortran + Java suites
            </span>
            <span className="opacity-40">·</span>
            <span>3D viewer with <strong className="text-foreground">three.js</strong>, inspired by <a href="https://github.com/Jing0715-fer/MolVision" target="_blank" rel="noreferrer" className="underline hover:text-foreground">MolVision</a></span>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://www.holeprogram.org/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              <BookOpen className="size-3.5" /> holeprogram.org
            </a>
            <span className="opacity-40">·</span>
            <a href="https://www.caver.cz/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              <Route className="size-3.5" /> caver.cz
            </a>
          </div>
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
