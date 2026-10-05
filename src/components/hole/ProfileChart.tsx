'use client'

import { useMemo, useState, useCallback } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from 'recharts'
import type { PoreProfile } from '@/lib/hole/types'
import { HOLE_NARROW, HOLE_MAX_GREEN, PORE_ZONE_COLORS, poreZoneColor } from '@/lib/hole/types'

interface ProfileChartProps {
  profile: PoreProfile
  onHover?: (t: number | null) => void
}

/**
 * 2D pore-profile chart — plots pore radius vs. channel coordinate,
 * with the HOLE three-zone colour convention (red/green/blue background bands)
 * and a marker at the constriction point (minimum radius).
 *
 * When the user hovers over the chart, onHover is called with the t value
 * so the 3D viewer can highlight the corresponding pore position.
 */
export function ProfileChart({ profile, onHover }: ProfileChartProps) {
  const [hoverT, setHoverT] = useState<number | null>(null)

  const data = useMemo(() => {
    return profile.samples.map(s => ({
      t: Number(s.t.toFixed(3)),
      r: Number(s.r.toFixed(3)),
      zone: poreZoneColor(s.r),
    }))
  }, [profile])

  const minR = profile.min_radius ?? Math.min(...data.map(d => d.r))
  const maxR = Math.max(profile.max_radius ?? Math.max(...data.map(d => d.r), 5), HOLE_MAX_GREEN + 1)
  const constrictionT = profile.min_t

  const handleHover = useCallback((activePayload: any) => {
    if (!activePayload || !activePayload.length || !onHover) {
      setHoverT(null)
      onHover?.(null)
      return
    }
    const t = activePayload[0]?.payload?.t
    if (t !== undefined) {
      setHoverT(t)
      onHover(t)
    }
  }, [onHover])

  const handleLeave = useCallback(() => {
    setHoverT(null)
    onHover?.(null)
  }, [onHover])

  if (data.length < 2) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No profile samples available.
      </div>
    )
  }

  // build zone bands
  const bands = data.slice(0, -1).map((d, i) => {
    const next = data[i + 1]
    const avgR = (d.r + next.r) / 2
    return {
      x1: d.t,
      x2: next.t,
      color: poreZoneColor(avgR),
    }
  })

  return (
    <div className="h-full w-full"
      onMouseLeave={handleLeave}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 24, bottom: 32, left: 12 }}>
          <defs>
            <linearGradient id="profileFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
          {bands.map((b, i) => (
            <ReferenceArea
              key={`band-${i}`}
              x1={b.x1}
              x2={b.x2}
              y1={0}
              y2={maxR}
              fill={b.color}
              fillOpacity={0.10}
              stroke="none"
            />
          ))}
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={{ fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 }}
            stroke="currentColor"
            strokeOpacity={0.3}
            label={{
              value: 'Channel coordinate t (Å)',
              position: 'insideBottom',
              offset: -16,
              style: { fontSize: 12, fill: 'currentColor', fillOpacity: 0.7 },
            }}
          />
          <YAxis
            domain={[0, Math.ceil(maxR * 1.1)]}
            tick={{ fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 }}
            stroke="currentColor"
            strokeOpacity={0.3}
            label={{
              value: 'Pore radius R (Å)',
              angle: -90,
              position: 'insideLeft',
              offset: 0,
              style: { fontSize: 12, fill: 'currentColor', fillOpacity: 0.7 },
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: 12,
            }}
            formatter={(value: number) => [`${value.toFixed(3)} Å`, 'Pore radius']}
            labelFormatter={(label: number) => `t = ${label.toFixed(2)} Å`}
            // Recharts calls this with the active payload on hover
            {...({ onHover: handleHover } as any)}
          />
          <ReferenceLine y={HOLE_NARROW} stroke={PORE_ZONE_COLORS.narrow} strokeDasharray="4 2"
            strokeOpacity={0.6}
            label={{ value: `narrow < ${HOLE_NARROW}`, position: 'right', fontSize: 10, fill: PORE_ZONE_COLORS.narrow, fillOpacity: 0.85 }} />
          <ReferenceLine y={HOLE_MAX_GREEN} stroke={PORE_ZONE_COLORS.wide} strokeDasharray="4 2"
            strokeOpacity={0.6}
            label={{ value: `wide ≥ ${HOLE_MAX_GREEN}`, position: 'right', fontSize: 10, fill: PORE_ZONE_COLORS.wide, fillOpacity: 0.85 }} />
          {constrictionT !== null && (
            <ReferenceLine x={constrictionT} stroke="#fbbf24" strokeDasharray="3 3"
              strokeOpacity={0.85}
              label={{
                value: `min R = ${minR.toFixed(3)} Å`,
                position: 'top',
                fontSize: 11,
                fill: '#fbbf24',
                fillOpacity: 1,
              }} />
          )}
          {/* Hover indicator: vertical line at the hovered t position */}
          {hoverT !== null && (
            <ReferenceLine x={hoverT} stroke="#ffffff" strokeOpacity={0.5} strokeWidth={1} />
          )}
          <Area type="monotone" dataKey="r" stroke="none" fill="url(#profileFill)" />
          <Line type="monotone" dataKey="r" stroke="#3b82f6" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
