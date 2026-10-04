'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes, Github, ExternalLink, BookOpen, Activity, BoxSelect,
  Loader2, AlertCircle, FileDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/toaster'
import { toast } from 'sonner'
import { RunForm } from '@/components/hole/RunForm'
import { Viewer3D } from '@/components/hole/Viewer3D'
import { ViewerControls } from '@/components/hole/ViewerControls'
import { ProfileChart } from '@/components/hole/ProfileChart'
import { ResultsPanel } from '@/components/hole/ResultsPanel'
import { DEFAULT_PARAMS, type RunParams, type RunResult, type HoleSphere, type HoleSurface } from '@/lib/hole/types'
import { HoleViewer, type HoleViewerOptions } from '@/lib/hole/viewer'
import {
  fetchHealth, fetchRadSets, fetchExamples, runHole, examplePdbUrl,
  type ExampleInfo, type RadSetInfo,
} from '@/lib/hole/api'

const EMPTY_SURFACE: HoleSurface = { triangles: [], colors: [] }

export default function Home() {
  // run form state
  const [params, setParams] = useState<RunParams>(DEFAULT_PARAMS)
  const [pdbFile, setPdbFile] = useState<File | null>(null)
  const [pdbName, setPdbName] = useState('')
  const [pdbText, setPdbText] = useState<string | null>(null)
  const [customRad, setCustomRad] = useState<File | null>(null)

  // backend metadata
  const [radSets, setRadSets] = useState<string[]>(['simple'])
  const [examples, setExamples] = useState<ExampleInfo[]>([])
  const [serviceReady, setServiceReady] = useState<boolean | null>(null)

  // run state
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // viewer state
  const [viewerOpts, setViewerOpts] = useState<HoleViewerOptions>({
    showCartoon: true,
    showBallStick: true,
    showSurface: true,
    showSpheres: false,
    showCentreLine: true,
    surfaceOpacity: 0.85,
    sphereScale: 1.0,
  })
  const viewerRef = useRef<HoleViewer | null>(null)

  // Fetch backend metadata on mount
  useEffect(() => {
    fetchHealth().then((h) => setServiceReady(h.env_ready)).catch(() => setServiceReady(false))
    fetchRadSets().then((r: RadSetInfo) => setRadSets(r.rad_sets)).catch(() => {})
    fetchExamples().then(setExamples).catch(() => {})
  }, [])

  // Load PDB text into the viewer when a new file is picked
  useEffect(() => {
    if (!pdbFile) { setPdbText(null); return }
    const reader = new FileReader()
    reader.onload = () => setPdbText(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => toast.error('Could not read PDB file')
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
      // apply the example's recommended params where possible
      // (gramicidin → endrad 5, no ignore; cholera toxin → connolly + ignore HOH; maltoporin → cvect Z + cpoint)
      const next = { ...DEFAULT_PARAMS }
      if (ex.id.includes('gramicidin')) {
        next.endrad = '5.0'
        next.ignore_residues = ''
        next.shorto = '0'  // full output so the profile is parsed
      } else if (ex.id.includes('choleratoxin')) {
        next.connolly = true
        next.ignore_residues = 'HOH TIP WAT'
        next.shorto = '0'  // shorto=2 suppresses the profile; keep full so we can plot it
      } else if (ex.id.includes('maltoporin')) {
        next.cvect_x = '0.0'; next.cvect_y = '0.0'; next.cvect_z = '1.0'
        next.cpoint_x = '-14.285'; next.cpoint_y = '47.809'; next.cpoint_z = '82.707'
        next.ignore_residues = 'FRU GLC MG HOH'
        next.shorto = '0'
      }
      setParams(next)
      toast.success(`Loaded ${pdb} (${(blob.size / 1024).toFixed(1)} KB)`)
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
      if (res.error) {
        toast.error('HOLE2 reported an error — see the log below.')
      } else {
        toast.success(`HOLE2 done: min radius ${res.summary.min_radius?.toFixed(3) ?? '—'} Å · ${res.summary.n_triangles} surface triangles`)
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

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Toaster />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
              <Boxes className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight">HOLE2 Web</h1>
              <p className="truncate text-[11px] text-muted-foreground">Ion-channel pore-analysis studio</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={serviceReady ? 'secondary' : 'outline'}
              className="gap-1.5 text-[10px]">
              <span className={`size-1.5 rounded-full ${serviceReady ? 'bg-emerald-500' : 'bg-amber-500'} ${serviceReady ? '' : 'animate-pulse'}`} />
              {serviceReady === null ? 'checking…' : serviceReady ? 'HOLE2 service ready' : 'service offline'}
            </Badge>
            <a href="https://github.com/osmart/hole2" target="_blank" rel="noreferrer"
              className="hidden sm:inline-flex">
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                <Github className="size-3.5" /> HOLE2 repo
              </Button>
            </a>
            <a href="https://github.com/Jing0715-fer/MolVision" target="_blank" rel="noreferrer"
              className="hidden md:inline-flex">
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                <ExternalLink className="size-3.5" /> MolVision
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* Main content — sticky footer layout */}
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">
        {/* Hero */}
        <section className="mb-6 grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-600 hover:bg-emerald-700">HOLE2 2.3.1</Badge>
              <Badge variant="outline" className="text-[10px]">Smart, Goodfellow & Wallace, 1996</Badge>
            </div>
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Analyse the pore dimensions of ion channels — in your browser.
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Upload a PDB structure, configure the pore probe (radius set, endrad, channel vector, ignore residues),
              and HOLE2 will compute the maximum-radius sphere that fits at each point along the pore.
              Visualise the triangulated pore surface in 3D (red = too narrow for water, green = single-water file,
              blue = wide), inspect the pore-radius profile chart, and download the original command-line output
              files (<code>.txt</code>, <code>.sph</code>, <code>.sos</code>, <code>.vmd_plot</code>) byte-for-byte
              identical to running <code>hole</code> + <code>sph_process</code> + <code>sos_triangle</code> locally.
            </p>
          </div>
          <div className="flex items-center justify-start gap-3 rounded-xl border border-border/50 bg-muted/20 p-4 lg:justify-end">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BookOpen className="size-4" />
              <span>Try the <strong className="text-foreground">gramicidin A</strong> demo for a 30-second tour.</span>
            </div>
          </div>
        </section>

        {/* Main 3-column grid */}
        <div className="grid gap-4 lg:grid-cols-[380px_1fr_320px]">
          {/* Left: run form */}
          <div className="space-y-4">
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
              onRun={handleRun}
              onReset={handleReset}
              running={running}
            />
          </div>

          {/* Middle: 3D viewer + profile chart */}
          <div className="space-y-4">
            <Tabs defaultValue="viewer" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="viewer" className="gap-1.5 text-xs">
                  <BoxSelect className="size-3.5" /> 3D viewer
                </TabsTrigger>
                <TabsTrigger value="profile" className="gap-1.5 text-xs">
                  <Activity className="size-3.5" /> Pore profile
                </TabsTrigger>
              </TabsList>
              <TabsContent value="viewer" className="mt-2">
                <div className="relative h-[60vh] min-h-[420px] overflow-hidden rounded-xl border border-border/60 bg-[#0b1220]">
                  {pdbText ? (
                    <Viewer3D
                      pdbText={pdbText}
                      spheres={spheres}
                      surface={surface}
                      centreline={centreline}
                      options={viewerOpts}
                      bgColor="#0b1220"
                      onReady={(v) => { viewerRef.current = v }}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-400">
                      <BoxSelect className="size-12 opacity-30" />
                      <div>
                        <p className="text-sm font-medium">No structure loaded</p>
                        <p className="text-xs opacity-70">Upload a PDB file or pick an example to begin.</p>
                      </div>
                    </div>
                  )}
                  {running && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2 text-foreground">
                        <Loader2 className="size-8 animate-spin text-emerald-500" />
                        <p className="text-sm font-medium">Running HOLE2…</p>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="profile" className="mt-2">
                <div className="h-[60vh] min-h-[420px] rounded-xl border border-border/60 bg-card p-4">
                  {profile ? (
                    <ProfileChart profile={profile} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                      <Activity className="size-12 opacity-30" />
                      <div>
                        <p className="text-sm font-medium">No profile yet</p>
                        <p className="text-xs opacity-70">Run HOLE2 to see the pore-radius vs. channel-coordinate plot.</p>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            {/* Mobile/tablet results below the viewer */}
            <div className="lg:hidden">
              <ResultsPanel result={result} loading={running} error={error} />
            </div>
          </div>

          {/* Right: viewer controls + results (desktop) */}
          <div className="hidden space-y-4 lg:block">
            <ViewerControls
              options={viewerOpts}
              onChange={setViewerOpts}
              onCapturePNG={handleCapturePNG}
            />
            <ResultsPanel result={result} loading={running} error={error} />
          </div>
        </div>
      </main>

      {/* Footer — sticky to bottom */}
      <footer className="mt-auto border-t border-border/60 bg-muted/20">
        <div className="mx-auto flex max-w-[1600px] flex-col items-start justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1.5">
              <Activity className="size-3.5" />
              HOLE2 web app · wrapping the original Fortran HOLE2 suite
            </span>
            <span className="opacity-50">·</span>
            <span>3D viewer built with <strong className="text-foreground">three.js</strong>, inspired by <a href="https://github.com/Jing0715-fer/MolVision" target="_blank" rel="noreferrer" className="underline hover:text-foreground">MolVision</a> (MIT)</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://www.holeprogram.org/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              <BookOpen className="size-3.5" /> holeprogram.org
            </a>
            <span className="opacity-50">·</span>
            <span className="inline-flex items-center gap-1">
              <FileDown className="size-3.5" /> Outputs match the CLI byte-for-byte
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
