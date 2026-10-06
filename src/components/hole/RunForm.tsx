'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, FileText, X, ChevronDown, Loader2, CornerDownLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/hole/SectionLabel'
import type { RunParams } from '@/lib/hole/types'
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
  running: boolean
}

export function RunForm(props: RunFormProps) {
  const { params, onParamsChange, pdbFile, pdbName, onPdbFile,
    customRad, onCustomRad, radSets, examples, onPickExample,
    onFetchPdbId, fetchingPdb, running } = props
  const pdbInputRef = useRef<HTMLInputElement>(null)
  const radInputRef = useRef<HTMLInputElement>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pdbIdInput, setPdbIdInput] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const set = useCallback((patch: Partial<RunParams>) => {
    onParamsChange({ ...params, ...patch })
  }, [params, onParamsChange])

  const handlePdbPick = (file: File | null) => {
    if (!file) { onPdbFile(null, ''); return }
    onPdbFile(file, file.name)
  }

  return (
    <div className="space-y-8">
      {/* ── Structure ─────────────────────────────────────────────────── */}
      <section className="space-y-3.5">
        <SectionLabel>Structure</SectionLabel>

        {/* Drop zone */}
        <div
          className={cn(
            'relative flex flex-col items-center justify-center border border-dashed px-4 py-7 transition-colors',
            pdbFile
              ? 'border-solid border-border bg-muted/40'
              : dragOver
                ? 'border-vermilion bg-vermilion/5'
                : 'bg-card hover:border-muted-foreground/40',
          )}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation(); setDragOver(false)
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
            <div className="flex w-full items-stretch justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium text-foreground">{pdbName}</p>
                  <p className="font-mono text-[10px] text-muted-foreground tnum">
                    {(pdbFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => pdbInputRef.current?.click()}
                >
                  swap
                </button>
                <button
                  type="button"
                  aria-label="Remove structure"
                  className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => handlePdbPick(null)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex flex-col items-center gap-1.5 text-center"
              onClick={() => pdbInputRef.current?.click()}
            >
              <Upload className="size-4 text-muted-foreground" />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/80">
                drop structure or browse
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/70">
                .pdb / .cif · max 50 MB
              </span>
            </button>
          )}
        </div>

        {/* RCSB fetch */}
        <div className="space-y-1.5">
          <Label htmlFor="pdb-id" className="protocol-label">Fetch from RCSB</Label>
          <div className="flex">
            <Input
              id="pdb-id"
              value={pdbIdInput}
              onChange={(e) => setPdbIdInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pdbIdInput.trim() && !fetchingPdb) {
                  e.preventDefault()
                  onFetchPdbId(pdbIdInput.trim())
                }
              }}
              placeholder="1GRM"
              className="h-8 rounded-r-none border-r-0 font-mono text-xs uppercase placeholder:text-muted-foreground/50"
              maxLength={4}
              disabled={fetchingPdb}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-r-sm border bg-card px-2.5 font-mono text-[10px] uppercase tracking-wider text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              disabled={fetchingPdb || pdbIdInput.trim().length !== 4}
              onClick={() => onFetchPdbId(pdbIdInput.trim())}
            >
              {fetchingPdb
                ? <Loader2 className="size-3 animate-spin" />
                : <CornerDownLeft className="size-3" />}
              fetch
            </button>
          </div>
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/70">
            4-character id · files.rcsb.org
          </p>
        </div>

        {/* Examples */}
        {examples.length > 0 && (
          <div className="space-y-1.5">
            <Label className="protocol-label">Bundled examples</Label>
            <div className="divide-y border border-border bg-card">
              {examples.map((ex) => (
                <div key={ex.id} className="group p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate font-mono text-[11px] font-medium text-foreground">
                      {ex.id}
                    </p>
                    {ex.pdb_files.length > 1 && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        {ex.pdb_files.length} files
                      </span>
                    )}
                  </div>
                  {ex.description && (
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                      {ex.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {ex.pdb_files.map((pdb) => (
                      <button
                        key={pdb}
                        type="button"
                        className="border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground/85 transition-colors hover:border-foreground hover:text-foreground disabled:opacity-40"
                        onClick={() => onPickExample(ex, pdb)}
                        disabled={running}
                        title={`Load ${pdb}`}
                      >
                        {pdb}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Probe parameters ──────────────────────────────────────────── */}
      <section className="space-y-3.5">
        <SectionLabel>Probe parameters</SectionLabel>

        {/* radius set */}
        <div className="space-y-1.5">
          <Label htmlFor="radius-set" className="protocol-label">vdW radius set</Label>
          <Select value={params.radius_set} onValueChange={(v) => set({ radius_set: v })}>
            <SelectTrigger id="radius-set" className="h-8 w-full rounded-none font-mono text-xs">
              <SelectValue>
                {(params.radius_set || 'simple')}.rad
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-[340px] rounded-none">
              {radSets.rad_sets.map((r) => (
                <SelectItem key={r.name} value={r.name} className="rounded-none py-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs">{r.name}.rad</span>
                    <span className="text-[10px] leading-tight text-muted-foreground">{r.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* endrad */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="endrad" className="protocol-label">End radius</Label>
            <span className="font-mono text-[10px] text-muted-foreground tnum">
              {params.endrad} å
            </span>
          </div>
          <Input
            id="endrad" type="number" step="0.1" min="1" max="40"
            value={params.endrad}
            onChange={(e) => set({ endrad: e.target.value })}
            className="h-8 rounded-none font-mono text-xs tnum"
          />
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/80">
            pore radius at which the trace stops. matches the fortran default
            (15 å). wide vestibule (e.g. trpm8 ~19 å cavity) → raise above the
            cavity or the trace ends at the first wide point.
          </p>
        </div>

        {/* custom rad */}
        <div className="space-y-1.5">
          <Label className="protocol-label">Custom .rad (optional)</Label>
          {customRad ? (
            <div className="flex items-center justify-between gap-2 border bg-muted/40 px-2 py-1.5">
              <span className="truncate font-mono text-xs">{customRad.name}</span>
              <button
                type="button"
                aria-label="Remove radius file"
                className="p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onCustomRad(null)}
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="flex h-8 w-full items-center justify-center gap-1.5 border bg-card font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
              onClick={() => radInputRef.current?.click()}
            >
              <Upload className="size-3" /> upload radius file
            </button>
          )}
          <input ref={radInputRef} type="file" accept=".rad,text/plain" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0] ?? null; onCustomRad(f) }} />
        </div>

        {/* advanced */}
        <div className="border border-border bg-card">
          <button
            type="button"
            className="flex w-full items-center justify-between px-2.5 py-2 text-left transition-colors hover:bg-accent"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen}
          >
            <span className="protocol-label">Channel geometry · advanced</span>
            <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')} />
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t p-2.5">
              {/* cpoint */}
              <div className="space-y-1.5">
                <Label className="protocol-label">Channel centre · CPOINT (å)</Label>
                <div className="grid grid-cols-3 gap-1">
                  <Input type="number" step="0.1" placeholder="x" value={params.cpoint_x}
                    onChange={(e) => set({ cpoint_x: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                  <Input type="number" step="0.1" placeholder="y" value={params.cpoint_y}
                    onChange={(e) => set({ cpoint_y: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                  <Input type="number" step="0.1" placeholder="z" value={params.cpoint_z}
                    onChange={(e) => set({ cpoint_z: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                </div>
              </div>
              {/* cvect */}
              <div className="space-y-1.5">
                <Label className="protocol-label">Channel vector · CVECT</Label>
                <div className="grid grid-cols-3 gap-1">
                  <Input type="number" step="0.1" placeholder="x" value={params.cvect_x}
                    onChange={(e) => set({ cvect_x: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                  <Input type="number" step="0.1" placeholder="y" value={params.cvect_y}
                    onChange={(e) => set({ cvect_y: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                  <Input type="number" step="0.1" placeholder="z" value={params.cvect_z}
                    onChange={(e) => set({ cvect_z: e.target.value })} className="h-7 rounded-none border-input font-mono text-xs tnum" />
                </div>
                <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/80">
                  for a symmetric oligomer the pore runs along the symmetry axis —
                  e.g. a C4 tetramer: cvect 0 0 1.
                </p>
              </div>
              {/* ignore residues */}
              <div className="space-y-1.5">
                <Label htmlFor="ignore" className="protocol-label">Ignore residues</Label>
                <Textarea id="ignore" rows={2} placeholder="HOH TIP WAT NA CL"
                  value={params.ignore_residues}
                  onChange={(e) => set({ ignore_residues: e.target.value })}
                  className="rounded-none border-input font-mono text-xs" />
              </div>
              {/* shorto + dotden */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="shorto" className="protocol-label">Shorto</Label>
                  <Select value={params.shorto} onValueChange={(v) => set({ shorto: v })}>
                    <SelectTrigger id="shorto" className="h-7 rounded-none font-mono text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="rounded-none">
                      {[0, 1, 2, 3].map((n) => (
                        <SelectItem key={n} value={String(n)} className="rounded-none">{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <div className="flex items-baseline justify-between">
                    <Label className="protocol-label">Dot density</Label>
                    <span className="font-mono text-[10px] text-muted-foreground tnum">{params.dotden}</span>
                  </div>
                  <Slider
                    value={[parseInt(params.dotden || '15', 10)]}
                    min={5} max={30} step={1}
                    onValueChange={(v) => set({ dotden: String(v[0]) })}
                    className="mt-2"
                  />
                  <p className="font-mono text-[9px] text-muted-foreground/70">surface mesh density only</p>
                </div>
              </div>
              {/* toggles */}
              <div className="space-y-2 border-t pt-3">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/85">
                    Connolly probe
                  </span>
                  <Switch checked={params.connolly}
                    onCheckedChange={(v) => set({ connolly: v })} className="scale-90" />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/85">
                    Smooth surface
                  </span>
                  <Switch checked={params.smooth_surface}
                    onCheckedChange={(v) => set({ smooth_surface: v })} className="scale-90" />
                </label>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
