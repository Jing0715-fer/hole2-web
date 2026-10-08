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
 * 2D pore-profile chart — pore radius vs. channel coordinate, drawn like a
 * journal figure: hairline axes, an ink trace, the HOLE three-zone bands as
 * faint colour washes and a vermilion marker at the constriction.
 *
 * Hovering the chart calls onHover(t) so the 3D viewer can highlight the
 * corresponding position along the pore.
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

  const handleHover = useCallback((state: { activePayload?: any[]; isTooltipActive?: boolean }) => {
    if (!onHover) return
    const payload = state?.activePayload
    if (!payload || !payload.length || !state?.isTooltipActive) {
      setHoverT(null)
      onHover(null)
      return
    }
    const t = payload[0]?.payload?.t
    if (t !== undefined && t !== null) {
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
      <div className="flex h-full items-center justify-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        no profile samples
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
    <div className="h-full w-full" onMouseLeave={handleLeave}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 14, right: 16, bottom: 26, left: -4 }}
          onMouseMove={handleHover}
          onMouseLeave={handleLeave}
        >
          <defs>
            <linearGradient id="profileFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1B1A17" stopOpacity={0.07} />
              <stop offset="100%" stopColor="#1B1A17" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          {/* horizontal hairlines only — journal figure convention */}
          <CartesianGrid stroke="currentColor" strokeOpacity={0.07} vertical={false} />
          {bands.map((b, i) => (
            <ReferenceArea
              key={`band-${i}`}
              x1={b.x1}
              x2={b.x2}
              y1={0}
              y2={maxR}
              fill={b.color}
              fillOpacity={0.07}
              stroke="none"
            />
          ))}
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={{ fontSize: 9, fill: 'currentColor', fillOpacity: 0.55, fontFamily: 'var(--font-geist-mono)' }}
            stroke="currentColor"
            strokeOpacity={0.25}
            tickLine={false}
            label={{
              value: 'channel coordinate t (å)',
              position: 'insideBottom',
              offset: -12,
              style: { fontSize: 9, fill: 'currentColor', fillOpacity: 0.55, fontFamily: 'var(--font-geist-mono)' },
            }}
          />
          <YAxis
            domain={[0, Math.ceil(maxR * 1.1)]}
            tick={{ fontSize: 9, fill: 'currentColor', fillOpacity: 0.55, fontFamily: 'var(--font-geist-mono)' }}
            stroke="currentColor"
            strokeOpacity={0.25}
            tickLine={false}
            width={38}
            label={{
              value: 'pore radius r (å)',
              angle: -90,
              position: 'insideLeft',
              offset: 6,
              style: { fontSize: 9, fill: 'currentColor', fillOpacity: 0.55, fontFamily: 'var(--font-geist-mono)' },
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 0,
              color: 'var(--foreground)',
              fontSize: 11,
              fontFamily: 'var(--font-geist-mono)',
              padding: '4px 8px',
            }}
            cursor={{ stroke: 'currentColor', strokeOpacity: 0.25 }}
            formatter={(value: number) => [`${value.toFixed(3)} å`, 'pore radius']}
            labelFormatter={(label: number) => `t = ${label.toFixed(2)} å`}
          />
          {/* zone thresholds — hairline references */}
          <ReferenceLine y={HOLE_NARROW} stroke="#B5401F" strokeDasharray="3 3" strokeOpacity={0.35}
            label={{ value: `narrow ${HOLE_NARROW}`, position: 'insideTopLeft', fontSize: 8, fill: '#B5401F', fillOpacity: 0.7, dy: 10 }} />
          <ReferenceLine y={HOLE_MAX_GREEN} stroke="#1F3A5F" strokeDasharray="3 3" strokeOpacity={0.35}
            label={{ value: `wide ${HOLE_MAX_GREEN}`, position: 'insideTopLeft', fontSize: 8, fill: '#1F3A5F', fillOpacity: 0.7, dy: 10 }} />
          {/* constriction — the vermilion annotation */}
          {constrictionT !== null && (
            <ReferenceLine x={constrictionT} stroke="#B5401F" strokeDasharray="2 2" strokeOpacity={0.9}
              label={{
                value: `r min = ${minR.toFixed(3)} å`,
                position: 'top',
                fontSize: 9,
                fill: '#B5401F',
                fontFamily: 'var(--font-geist-mono)',
              }} />
          )}
          {hoverT !== null && (
            <ReferenceLine x={hoverT} stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
          )}
          <Area type="monotone" dataKey="r" stroke="none" fill="url(#profileFill)" />
          <Line type="monotone" dataKey="r" stroke="#1B1A17" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
