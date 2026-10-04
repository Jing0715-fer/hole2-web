'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, FileText, X, Settings2, Beaker, Download, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { DEFAULT_PARAMS, type RunParams } from '@/lib/hole/types'
import type { ExampleInfo, RadSetInfo } from '@/lib/hole/api'

interface RunFormProps {
  params: RunParams
  onParamsChange: (next: RunParams) => void
  pdbFile: File | null
  pdbName: string
  onPdbFile: (file: File | null, name: string) => void
  customRad: File | null
  onCustomRad: (file: File | null) => void
  radSets: RadSetInfo
  examples: ExampleInfo[]
  onPickExample: (ex: ExampleInfo, pdb: string) => void
  onFetchPdbId: (pdbId: string) => Promise<void>
  fetchingPdb: boolean
  onRun: () => void
  onReset: () => void
  running: boolean
  disabled?: boolean
}

export function RunForm(props: RunFormProps) {
  const { params, onParamsChange, pdbFile, pdbName, onPdbFile,
    customRad, onCustomRad, radSets, examples, onPickExample,
    onFetchPdbId, fetchingPdb, onRun, onReset, running, disabled } = props
  const pdbInputRef = useRef<HTMLInputElement>(null)
  const radInputRef = useRef<HTMLInputElement>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pdbIdInput, setPdbIdInput] = useState('')

  const set = useCallback((patch: Partial<RunParams>) => {
    onParamsChange({ ...params, ...patch })
  }, [params, onParamsChange])

  const handlePdbPick = (file: File | null) => {
    if (!file) { onPdbFile(null, ''); return }
    onPdbFile(file, file.name)
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Beaker className="size-4 text-emerald-500" />
          Run configuration
        </CardTitle>
        <CardDescription className="text-xs">
          Upload a PDB coordinate file, pick an example, or fetch from RCSB.
          HOLE2 will reproduce the original command-line output exactly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* PDB file upload */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">Input structure (PDB or mmCIF)</Label>
          <div
            className={cn(
              'group relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/60 bg-muted/30 px-4 py-6 transition-colors',
              pdbFile ? 'border-emerald-500/50 bg-emerald-500/5' : 'hover:border-emerald-500/40 hover:bg-emerald-500/5',
            )}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) handlePdbPick(f)
            }}
          >
            <input
              ref={pdbInputRef}
              type="file"
              accept=".pdb,.ent,.cif,.mcif,text/plain"
              className="sr-only"
              onChange={(e) => handlePdbPick(e.target.files?.[0] ?? null)}
            />
            {pdbFile ? (
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-5 shrink-0 text-emerald-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{pdbName}</p>
                    <p className="text-xs text-muted-foreground">{(pdbFile.size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                    onClick={() => pdbInputRef.current?.click()}>
                    Replace
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                    onClick={() => handlePdbPick(null)}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flex flex-col items-center gap-1 text-center"
                onClick={() => pdbInputRef.current?.click()}
              >
                <Upload className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">Drop structure here or click to browse</span>
                <span className="text-xs text-muted-foreground">.pdb / .cif — max 50 MB</span>
              </button>
            )}
          </div>
        </div>

        {/* PDB ID fetch */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Or fetch from RCSB by PDB ID</Label>
          <div className="flex gap-2">
            <Input
              value={pdbIdInput}
              onChange={(e) => setPdbIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pdbIdInput.trim() && !fetchingPdb) {
                  e.preventDefault()
                  onFetchPdbId(pdbIdInput.trim())
                }
              }}
              placeholder="e.g. 1grm"
              className="h-9 font-mono text-sm uppercase"
              maxLength={4}
              disabled={fetchingPdb}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs"
              disabled={fetchingPdb || pdbIdInput.trim().length !== 4}
              onClick={() => onFetchPdbId(pdbIdInput.trim())}
            >
              {fetchingPdb ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Fetch
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            4-character RCSB ID (e.g. 1grm, 1bl8, 4hhb). Fetches from files.rcsb.org.
          </p>
        </div>

        {/* Examples */}
        {examples.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs font-medium">Or load a bundled example</Label>
            <div className="grid grid-cols-1 gap-2">
              {examples.map((ex) => (
                <div key={ex.id} className="rounded-lg border border-border/50 bg-muted/20 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{ex.id}</p>
                      <p className="text-xs text-muted-foreground">{ex.description}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ex.pdb_files.map((pdb) => (
                      <Button
                        key={pdb}
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs font-mono"
                        onClick={() => onPickExample(ex, pdb)}
                      >
                        {pdb}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Radius set + endrad */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="radius-set" className="text-xs font-medium">vdW radius set</Label>
            <Select value={params.radius_set} onValueChange={(v) => set({ radius_set: v })}>
              <SelectTrigger id="radius-set" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {radSets.rad_sets.map((r) => (
                  <SelectItem key={r.name} value={r.name}>
                    <div className="flex flex-col">
                      <span className="font-mono">{r.name}.rad</span>
                      <span className="text-[10px] text-muted-foreground">{r.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] leading-snug text-muted-foreground">
              {radSets.rad_sets.find(r => r.name === params.radius_set)?.description ?? 'Pick a radius set'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endrad" className="text-xs font-medium">End radius (Å)</Label>
            <Input id="endrad" type="number" step="0.1" min="1" max="20"
              value={params.endrad}
              onChange={(e) => set({ endrad: e.target.value })}
              className="h-9 font-mono" />
            <p className="text-[10px] leading-snug text-muted-foreground">
              Pore radius at which HOLE stops (5 Å = narrow channel)
            </p>
          </div>
        </div>

        {/* Custom radius file */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Custom radius file (optional)</Label>
          {customRad ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5">
              <span className="truncate text-xs font-mono">{customRad.name}</span>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onCustomRad(null)}>
                <X className="size-3" />
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="h-8 w-full text-xs"
              onClick={() => radInputRef.current?.click()}>
              <Upload className="mr-1 size-3" /> Upload .rad file
            </Button>
          )}
          <input ref={radInputRef} type="file" accept=".rad,text/plain" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0] ?? null; onCustomRad(f) }} />
        </div>

        {/* Advanced toggle */}
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-muted/40"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <span className="flex items-center gap-1.5">
            <Settings2 className="size-3.5" /> Advanced options
          </span>
          <Badge variant="outline" className="text-[10px]">
            {advancedOpen ? 'Hide' : 'Show'}
          </Badge>
        </button>

        {advancedOpen && (
          <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3">
            {/* cpoint */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Channel centre point (CPOINT)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input type="number" step="0.1" placeholder="x" value={params.cpoint_x}
                  onChange={(e) => set({ cpoint_x: e.target.value })} className="h-8 font-mono text-xs" />
                <Input type="number" step="0.1" placeholder="y" value={params.cpoint_y}
                  onChange={(e) => set({ cpoint_y: e.target.value })} className="h-8 font-mono text-xs" />
                <Input type="number" step="0.1" placeholder="z" value={params.cpoint_z}
                  onChange={(e) => set({ cpoint_z: e.target.value })} className="h-8 font-mono text-xs" />
              </div>
            </div>
            {/* cvect */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Channel vector (CVECT)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input type="number" step="0.1" placeholder="x" value={params.cvect_x}
                  onChange={(e) => set({ cvect_x: e.target.value })} className="h-8 font-mono text-xs" />
                <Input type="number" step="0.1" placeholder="y" value={params.cvect_y}
                  onChange={(e) => set({ cvect_y: e.target.value })} className="h-8 font-mono text-xs" />
                <Input type="number" step="0.1" placeholder="z" value={params.cvect_z}
                  onChange={(e) => set({ cvect_z: e.target.value })} className="h-8 font-mono text-xs" />
              </div>
            </div>
            {/* ignore residues */}
            <div className="space-y-1.5">
              <Label htmlFor="ignore" className="text-xs font-medium">Ignore residues (space-separated)</Label>
              <Textarea id="ignore" rows={2} placeholder="e.g. HOH TIP WAT NA CL"
                value={params.ignore_residues}
                onChange={(e) => set({ ignore_residues: e.target.value })}
                className="font-mono text-xs" />
            </div>
            {/* shorto + dotden */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="shorto" className="text-xs font-medium">Short output level (SHORTO)</Label>
                <Select value={params.shorto} onValueChange={(v) => set({ shorto: v })}>
                  <SelectTrigger id="shorto" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Dot density: {params.dotden}</Label>
                <Slider
                  value={[parseInt(params.dotden || '15', 10)]}
                  min={5} max={30} step={1}
                  onValueChange={(v) => set({ dotden: String(v[0]) })}
                />
              </div>
            </div>
            {/* toggles */}
            <div className="flex flex-wrap gap-4 pt-1">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={params.connolly}
                  onCheckedChange={(v) => set({ connolly: v })} />
                <span>Connolly probe</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={params.smooth_surface}
                  onCheckedChange={(v) => set({ smooth_surface: v })} />
                <span>Smooth surface</span>
              </label>
            </div>
          </div>
        )}

        {/* Run / reset buttons */}
        <div className="flex gap-2 pt-1">
          <Button
            className="flex-1 bg-emerald-600 hover:bg-emerald-700"
            onClick={onRun}
            disabled={disabled || running || !pdbFile}
          >
            {running ? 'Running HOLE2…' : 'Run HOLE2 analysis'}
          </Button>
          <Button variant="outline" onClick={onReset} disabled={running}>
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export { DEFAULT_PARAMS }
