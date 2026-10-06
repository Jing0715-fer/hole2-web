'use client'

import { Eye, EyeOff, Layers, LineChart, Activity, Camera, Route } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import type { HoleViewerOptions } from '@/components/hole/Viewer3D'
import { HOLE_NARROW, HOLE_MAX_GREEN, PORE_ZONE_COLORS } from '@/lib/hole/types'

interface ViewerControlsProps {
  options: HoleViewerOptions
  onChange: (next: HoleViewerOptions) => void
  onCapturePNG: () => void
  /** 'hole' shows HOLE-specific layers; 'caver' shows the CAVER tunnels toggle. */
  mode?: 'hole' | 'caver'
}

interface ToggleProps {
  icon: React.ReactNode
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}

function Toggle({ icon, label, checked, onChange, hint }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2 transition-colors hover:border-border/60">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{label}</p>
          {hint && <p className="truncate text-[10px] text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function ViewerControls({ options, onChange, onCapturePNG, mode = 'hole' }: ViewerControlsProps) {
  const set = (patch: Partial<HoleViewerOptions>) => onChange({ ...options, ...patch })

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Layers className="size-4 text-emerald-500" />
          3D viewer layers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <Toggle icon={<Eye className="size-4" />} label="Cartoon" hint="Helix (red) / sheet (amber) / loop"
          checked={options.showCartoon} onChange={(v) => set({ showCartoon: v })} />
        <Toggle icon={<Eye className="size-4" />} label="Ball & stick" hint="Ligands + hetero atoms"
          checked={options.showBallStick} onChange={(v) => set({ showBallStick: v })} />
        {mode === 'caver' ? (
          <Toggle icon={<Route className="size-4" />} label="CAVER tunnels" hint="Access tunnels + starting point"
            checked={options.showTunnels} onChange={(v) => set({ showTunnels: v })} />
        ) : (
          <>
            <Toggle icon={<Activity className="size-4" />} label="HOLE surface" hint="Triangulated pore wall"
              checked={options.showSurface} onChange={(v) => set({ showSurface: v })} />
            <Toggle icon={<LineChart className="size-4" />} label="Centre line" hint="Pore centre-line tube"
              checked={options.showCentreLine} onChange={(v) => set({ showCentreLine: v })} />
            <Toggle icon={<EyeOff className="size-4" />} label="Pore side chains" hint="Residues lining the pore (≤6 Å)"
              checked={options.showPoreSideChains} onChange={(v) => set({ showPoreSideChains: v })} />
            <Toggle icon={<EyeOff className="size-4" />} label="Sampled spheres" hint="Pore probe spheres"
              checked={options.showSpheres} onChange={(v) => set({ showSpheres: v })} />
          </>
        )}

        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Surface opacity</Label>
            <span className="font-mono text-xs text-muted-foreground">{(options.surfaceOpacity * 100).toFixed(0)}%</span>
          </div>
          <Slider value={[Math.round(options.surfaceOpacity * 100)]} min={10} max={100} step={5}
            onValueChange={(v) => set({ surfaceOpacity: v[0] / 100 })} />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Sphere scale</Label>
            <span className="font-mono text-xs text-muted-foreground">{options.sphereScale.toFixed(2)}×</span>
          </div>
          <Slider value={[Math.round(options.sphereScale * 100)]} min={20} max={200} step={10}
            onValueChange={(v) => set({ sphereScale: v[0] / 100 })} />
        </div>

        <Button variant="outline" size="sm" className="w-full text-xs" onClick={onCapturePNG}>
          <Camera className="mr-1 size-3.5" /> Capture PNG
        </Button>

        {/* Mouse controls help */}
        <div className="space-y-1.5 rounded-md border border-border/40 bg-muted/20 p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Mouse controls</p>
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <div className="flex justify-between"><span>Left drag</span><span className="font-mono">Rotate</span></div>
            <div className="flex justify-between"><span>Right drag</span><span className="font-mono">Pan</span></div>
            <div className="flex justify-between"><span>Scroll</span><span className="font-mono">Zoom</span></div>
            <div className="flex justify-between"><span>Middle click</span><span className="font-mono">Center atom</span></div>
            <div className="flex justify-between"><span>Double click</span><span className="font-mono">Zoom to atom</span></div>
            <div className="flex justify-between"><span>Hover</span><span className="font-mono">Residue info</span></div>
          </div>
        </div>

        {/* Colour legend */}
        <div className="space-y-1.5 rounded-md border border-border/40 bg-muted/20 p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Pore-zone legend</p>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="size-3 rounded-sm" style={{ background: PORE_ZONE_COLORS.narrow }} />
              <span>Narrow &lt; {HOLE_NARROW} Å</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="size-3 rounded-sm" style={{ background: PORE_ZONE_COLORS.mid }} />
              <span>{HOLE_NARROW}–{HOLE_MAX_GREEN} Å (single water)</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="size-3 rounded-sm" style={{ background: PORE_ZONE_COLORS.wide }} />
              <span>Wide ≥ {HOLE_MAX_GREEN} Å</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
