'use client'

import { Camera, MousePointer2 } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { HoleViewerOptions } from '@/components/hole/Viewer3D'
import { HOLE_NARROW, HOLE_MAX_GREEN, PORE_ZONE_COLORS } from '@/lib/hole/types'

interface ViewerControlsProps {
  options: HoleViewerOptions
  onChange: (next: HoleViewerOptions) => void
  onCapturePNG: () => void
  /** 'hole' shows HOLE-specific layers; 'caver' shows the CAVER tunnels toggle. */
  mode?: 'hole' | 'caver'
}

function LayerRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="group flex cursor-pointer select-none items-center justify-between gap-3 py-[5px]">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-foreground/85">
          {label}
        </span>
        <span className="hidden truncate text-[9px] text-muted-foreground/70 sm:inline">{hint}</span>
      </span>
      {/* square checkbox — drawn, not stock */}
      <span className="relative flex size-[15px] shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden
          className={cn(
            'flex size-[15px] items-center justify-center border transition-colors',
            'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
            checked
              ? 'border-foreground bg-foreground'
              : 'border-input bg-card group-hover:border-muted-foreground',
          )}
        >
          {checked && (
            <svg viewBox="0 0 10 10" className="size-2.5 text-primary-foreground" aria-hidden>
              <path d="M1 5.5 3.5 8 9 2" fill="none" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          )}
        </span>
      </span>
    </label>
  )
}

export function ViewerControls({ options, onChange, onCapturePNG, mode = 'hole' }: ViewerControlsProps) {
  const set = (patch: Partial<HoleViewerOptions>) => onChange({ ...options, ...patch })

  return (
    <div className="space-y-4">
      <div className="divide-y border border-border bg-card px-3">
        <LayerRow label="cartoon" hint="helix / sheet ribbon"
          checked={options.showCartoon} onChange={(v) => set({ showCartoon: v })} />
        <LayerRow label="ball & stick" hint="ligands · hetero"
          checked={options.showBallStick} onChange={(v) => set({ showBallStick: v })} />
        {mode === 'caver' ? (
          <LayerRow label="caver tunnels" hint="access tunnels + start"
            checked={options.showTunnels} onChange={(v) => set({ showTunnels: v })} />
        ) : (
          <>
            <LayerRow label="pore surface" hint="triangulated wall"
              checked={options.showSurface} onChange={(v) => set({ showSurface: v })} />
            <LayerRow label="centre line" hint="pore axis tube"
              checked={options.showCentreLine} onChange={(v) => set({ showCentreLine: v })} />
            <LayerRow label="pore side chains" hint="lining residues ≤ 6 å"
              checked={options.showPoreSideChains} onChange={(v) => set({ showPoreSideChains: v })} />
            <LayerRow label="probe spheres" hint="sampled spheres"
              checked={options.showSpheres} onChange={(v) => set({ showSpheres: v })} />
          </>
        )}
      </div>

      {/* sliders */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="protocol-label">surface opacity</span>
            <span className="font-mono text-[10px] text-muted-foreground tnum">
              {(options.surfaceOpacity * 100).toFixed(0)}%
            </span>
          </div>
          <Slider value={[Math.round(options.surfaceOpacity * 100)]} min={10} max={100} step={5}
            onValueChange={(v) => set({ surfaceOpacity: v[0] / 100 })} />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="protocol-label">sphere scale</span>
            <span className="font-mono text-[10px] text-muted-foreground tnum">
              {options.sphereScale.toFixed(2)}×
            </span>
          </div>
          <Slider value={[Math.round(options.sphereScale * 100)]} min={20} max={200} step={10}
            onValueChange={(v) => set({ sphereScale: v[0] / 100 })} />
        </div>
      </div>

      <Button
        variant="outline"
        className="h-8 w-full gap-1.5 rounded-none font-mono text-[10px] uppercase tracking-[0.14em]"
        onClick={onCapturePNG}
      >
        <Camera className="size-3.5" /> capture png
      </Button>

      {/* mouse map */}
      <div className="space-y-1.5 border border-border bg-card px-3 py-2.5">
        <p className="flex items-center gap-1.5 protocol-label">
          <MousePointer2 className="size-3" /> pointer map
        </p>
        <div className="space-y-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          <div className="flex justify-between"><span className="text-foreground/60">left drag</span><span>rotate</span></div>
          <div className="flex justify-between"><span className="text-foreground/60">right drag</span><span>pan</span></div>
          <div className="flex justify-between"><span className="text-foreground/60">wheel</span><span>zoom</span></div>
          <div className="flex justify-between"><span className="text-foreground/60">middle click</span><span>centre atom</span></div>
          <div className="flex justify-between"><span className="text-foreground/60">double click</span><span>zoom to atom</span></div>
          <div className="flex justify-between"><span className="text-foreground/60">hover</span><span>residue info</span></div>
        </div>
      </div>

      {/* pore-zone legend */}
      <div className="space-y-1.5 border border-border bg-card px-3 py-2.5">
        <p className="protocol-label">pore zones</p>
        <div className="space-y-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="size-2.5 shrink-0" style={{ background: PORE_ZONE_COLORS.narrow }} />
            <span>narrow &lt; {HOLE_NARROW} å</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="size-2.5 shrink-0" style={{ background: PORE_ZONE_COLORS.mid }} />
            <span>{HOLE_NARROW}–{HOLE_MAX_GREEN} å · single water</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="size-2.5 shrink-0" style={{ background: PORE_ZONE_COLORS.wide }} />
            <span>wide ≥ {HOLE_MAX_GREEN} å</span>
          </div>
        </div>
      </div>
    </div>
  )
}
