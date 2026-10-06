'use client'

import { useState, useCallback } from 'react'
import { Search, Loader2, Upload, Play, RotateCcw, ChevronDown, ChevronRight, MapPin, Crosshair } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import type { CaverParams } from '@/lib/caver/types'
import { DEFAULT_CAVER_PARAMS } from '@/lib/caver/types'

interface CaverRunFormProps {
  params: CaverParams
  onParamsChange: (p: CaverParams) => void
  pdbFile: File | null
  pdbName: string
  onPdbFile: (f: File | null, name: string) => void
  onRun: () => void
  onReset: () => void
  running: boolean
}

export function CaverRunForm({
  params, onParamsChange, pdbFile, pdbName, onPdbFile,
  onRun, onReset, running,
}: CaverRunFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pickMode, setPickMode] = useState(false)

  const set = useCallback(<K extends keyof CaverParams>(key: K, value: CaverParams[K]) => {
    onParamsChange({ ...params, [key]: value })
  }, [params, onParamsChange])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    onPdbFile(f, f?.name ?? '')
  }, [onPdbFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f && /\.(pdb|cif|ent)$/i.test(f.name)) onPdbFile(f, f.name)
  }, [onPdbFile])

  // Pick starting point by clicking on the 3D viewer — emits a custom event
  // that page.tsx listens for and updates the params
  const handlePickPoint = useCallback(() => {
    setPickMode(!pickMode)
    window.dispatchEvent(new CustomEvent('caver-pick-starting-point', {
      detail: { active: !pickMode },
    }))
  }, [pickMode])

  // Listen for picked coordinates from the 3D viewer
  useState(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('caver-point-picked', (e: Event) => {
        const ce = e as CustomEvent
        if (ce.detail) {
          set('start_x', ce.detail.x.toFixed(2))
          set('start_y', ce.detail.y.toFixed(2))
          set('start_z', ce.detail.z.toFixed(2))
          setPickMode(false)
        }
      })
    }
  })

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Search className="size-4 text-emerald-500" />
          CAVER Analysis
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Find access tunnels from an active site to the protein surface
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* PDB file upload */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Structure file</Label>
          {pdbFile ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-400/40 bg-emerald-50/50 px-3 py-2 dark:bg-emerald-950/20">
              <span className="truncate text-xs font-medium">{pdbName}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost" size="sm" className="h-6 px-2 text-xs"
                  onClick={() => onPdbFile(null, '')}
                >
                  Replace
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0"
                  onClick={() => onPdbFile(null, '')}
                  title="Remove"
                >
                  ×
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-center cursor-pointer hover:border-emerald-400/50 hover:bg-emerald-50/20 transition-colors"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => document.getElementById('caver-pdb-input')?.click()}
            >
              <Upload className="size-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Drop .pdb / .cif or click</span>
            </div>
          )}
          <input
            id="caver-pdb-input" type="file"
            accept=".pdb,.cif,.ent"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Starting point */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Starting point (x, y, z)</Label>
            <Button
              variant={pickMode ? 'default' : 'ghost'}
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={handlePickPoint}
            >
              <Crosshair className="size-3" />
              {pickMode ? 'Click in 3D…' : 'Pick in 3D'}
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Input
              type="number" step="0.1"
              value={params.start_x}
              onChange={(e) => set('start_x', e.target.value)}
              className="h-8 text-xs"
              placeholder="x"
            />
            <Input
              type="number" step="0.1"
              value={params.start_y}
              onChange={(e) => set('start_y', e.target.value)}
              className="h-8 text-xs"
              placeholder="y"
            />
            <Input
              type="number" step="0.1"
              value={params.start_z}
              onChange={(e) => set('start_z', e.target.value)}
              className="h-8 text-xs"
              placeholder="z"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Typically the active-site centre — tunnels radiate outward from here
          </p>
        </div>

        {/* Core parameters */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">Probe radius (Å)</Label>
            <Input
              type="number" step="0.1" min="0.3" max="5.0"
              value={params.probe_radius}
              onChange={(e) => set('probe_radius', e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Shell radius (Å)</Label>
            <Input
              type="number" step="0.5" min="1" max="20"
              value={params.shell_radius}
              onChange={(e) => set('shell_radius', e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Shell depth</Label>
            <Input
              type="number" step="1" min="1" max="10"
              value={params.shell_depth}
              onChange={(e) => set('shell_depth', e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Approx. balls</Label>
            <Select
              value={params.number_of_approximating_balls}
              onValueChange={(v) => set('number_of_approximating_balls', v)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="4">4 (fast)</SelectItem>
                <SelectItem value="6">6</SelectItem>
                <SelectItem value="8">8</SelectItem>
                <SelectItem value="12">12 (default)</SelectItem>
                <SelectItem value="20">20 (precise)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Clustering threshold */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Clustering threshold (Å)</Label>
            <span className="font-mono text-[10px] text-muted-foreground">{params.clustering_threshold}</span>
          </div>
          <Input
            type="number" step="0.5" min="0.5" max="20"
            value={params.clustering_threshold}
            onChange={(e) => set('clustering_threshold', e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[10px] text-muted-foreground">
            Max distance for two tunnels to belong to the same cluster
          </p>
        </div>

        {/* Advanced options */}
        <Separator />
        <button
          className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Advanced options
        </button>
        {showAdvanced && (
          <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Max distance (Å)</Label>
                <Input
                  type="number" step="0.5"
                  value={params.max_distance}
                  onChange={(e) => set('max_distance', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Desired radius (Å)</Label>
                <Input
                  type="number" step="0.5"
                  value={params.desired_radius}
                  onChange={(e) => set('desired_radius', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Max tunnels</Label>
                <Input
                  type="number" step="100"
                  value={params.max_number_of_tunnels}
                  onChange={(e) => set('max_number_of_tunnels', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Java heap (MB)</Label>
                <Input
                  type="number" step="256"
                  value={params.java_heap}
                  onChange={(e) => set('java_heap', e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Seed</Label>
                <Input
                  type="text"
                  value={params.seed}
                  onChange={(e) => set('seed', e.target.value)}
                  className="h-8 text-xs"
                  placeholder="empty = random"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Ignore residues (space-separated)</Label>
              <Textarea
                value={params.ignore_residues}
                onChange={(e) => set('ignore_residues', e.target.value)}
                className="min-h-[36px] text-xs"
                placeholder="HOH WAT"
              />
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          <Button
            className="flex-1 gap-1.5 text-xs"
            size="sm"
            disabled={!pdbFile || running}
            onClick={onRun}
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {running ? 'Searching tunnels…' : 'Find tunnels'}
          </Button>
          <Button
            variant="outline" size="sm" className="text-xs"
            disabled={running}
            onClick={onReset}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export { DEFAULT_CAVER_PARAMS }
