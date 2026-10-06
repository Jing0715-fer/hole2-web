'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Github, ArrowRight, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { RunForm } from '@/components/hole/RunForm'
import { Viewer3D } from '@/components/hole/Viewer3D'
import { ViewerControls } from '@/components/hole/ViewerControls'
import { ProfileChart } from '@/components/hole/ProfileChart'
import { ResultsPanel } from '@/components/hole/ResultsPanel'
import { HistoryPanel } from '@/components/hole/HistoryPanel'
import { SectionLabel } from '@/components/hole/SectionLabel'
import { DEFAULT_PARAMS, type RunParams, type RunResult, type HoleSphere, type HoleSurface } from '@/lib/hole/types'
import type { HoleViewerOptions } from '@/components/hole/Viewer3D'
import {
  fetchHealth, fetchRadSets, fetchExamples, runHole, fetchPdbId,
  type ExampleInfo, type RadSetInfo,
} from '@/lib/hole/api'
import { loadHistory, addToHistory, removeFromHistory, clearHistory, type HistoryEntry } from '@/lib/hole/history'
import { cn } from '@/lib/utils'

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
    surfaceOpacity: 1.0,
    sphereScale: 1.0,
  })
  const viewerRef = useRef<{ capturePNG: () => string; highlightPorePosition?: (t: number | null) => void } | null>(null)

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

  // Run stopwatch
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    setRunElapsed(0)
    const t = setInterval(() => setRunElapsed((Date.now() - start) / 1000), 100)
    return () => clearInterval(t)
  }, [running])

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
  }, [])

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

  // ⌘/Ctrl + Enter runs the analysis
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (pdbFile && !running) handleRun()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pdbFile, running, handleRun])

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
          </div>
          {/* Run action — pinned to the bottom of the rail */}
          <div className="shrink-0 border-t bg-card px-4 py-3 sm:px-5">
            <div className="flex gap-2">
              <Button
                className="h-10 flex-1 gap-2 font-mono text-[11px] uppercase tracking-[0.14em]"
                onClick={handleRun}
                disabled={running || !pdbFile}
              >
                {running
                  ? <span className="tnum">tracing · {runElapsed.toFixed(1)}&nbsp;s</span>
                  : <>Run HOLE2 <ArrowRight className="size-3.5" /></>}
              </Button>
              <Button
                variant="outline"
                className="h-10 px-3 font-mono text-[11px] uppercase tracking-[0.14em]"
                onClick={handleReset}
                disabled={running}
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

        {/* Centre — the stage: 3D viewer + radius profile */}
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
                spheres={spheres}
                surface={surface}
                centreline={centreline}
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
            {profile && !running && (
              <div className="pointer-events-none absolute right-4 top-3 font-mono text-[10px] uppercase tracking-[0.14em] text-canvas-foreground/60 tnum">
                r<sub>min</sub> {profile.min_radius?.toFixed(3) ?? '—'} å · {profile.n_samples} samples
              </div>
            )}

            {/* bottom-right mouse map */}
            <div className="pointer-events-none absolute bottom-3 right-4 hidden font-mono text-[9px] uppercase tracking-[0.12em] text-canvas-foreground/40 sm:block">
              left·rotate&nbsp;&nbsp;wheel·zoom&nbsp;&nbsp;right·pan
            </div>

            {/* running state — instrument trace overlay */}
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
          </div>

          {/* Radius profile */}
          <div className="flex h-[236px] shrink-0 flex-col border-t bg-card">
            <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b px-4">
              <SectionLabel className="flex-1">Radius profile R(t)</SectionLabel>
              {profile && (
                <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground tnum">
                  <span>r<sub>min</sub> <b className="font-semibold text-vermilion">{profile.min_radius?.toFixed(3) ?? '—'}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>r<sub>max</sub> <b className="font-semibold text-foreground">{profile.max_radius?.toFixed(3) ?? '—'}</b></span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>length <b className="font-semibold text-foreground">{profile.pore_length?.toFixed(1) ?? '—'}</b> å</span>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 p-1">
              {profile ? (
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
              )}
            </div>
          </div>
        </div>

        {/* Right rail — readout, layers, history */}
        <div className="min-h-0 min-w-0 overflow-y-auto border-t px-4 py-5 [scrollbar-gutter:stable] lg:border-t-0 lg:border-l sm:px-5">
          <div className="space-y-7">
            <ResultsPanel result={result} loading={running} error={error} />
            <section className="space-y-3">
              <SectionLabel>Viewer layers</SectionLabel>
              <ViewerControls options={viewerOpts} onChange={setViewerOpts} onCapturePNG={handleCapturePNG} />
            </section>
            <HistoryPanel
              entries={history}
              selectedIds={selectedHistoryIds}
              onToggleSelect={handleToggleHistorySelect}
              onRemove={handleRemoveHistory}
              onClear={handleClearHistory}
            />
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
          <span className="hidden sm:inline">outputs match cli byte-for-byte</span>
        </div>
      </footer>
    </div>
  )
}
