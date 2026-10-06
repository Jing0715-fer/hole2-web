'use client'

import { useState, useMemo } from 'react'
import { Trash2, Download, X, GitCompare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionLabel } from '@/components/hole/SectionLabel'
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import type { HistoryEntry } from '@/lib/hole/history'
import { buildComparisonData, exportComparisonTSVNormalized, downloadTSV } from '@/lib/hole/history'
import { HOLE_NARROW, HOLE_MAX_GREEN } from '@/lib/hole/types'

interface HistoryPanelProps {
  entries: HistoryEntry[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onRemove: (id: string) => void
  onClear: () => void
}

export function HistoryPanel({ entries, selectedIds, onToggleSelect, onRemove, onClear }: HistoryPanelProps) {
  const [showCompare, setShowCompare] = useState(false)

  const selectedEntries = useMemo(
    () => entries.filter(e => selectedIds.has(e.id)),
    [entries, selectedIds],
  )

  const compareData = useMemo(() => {
    return buildComparisonData(selectedEntries)
  }, [selectedEntries])

  const handleExport = () => {
    const tsv = exportComparisonTSVNormalized(selectedEntries)
    downloadTSV(tsv, `hole2-comparison-${Date.now()}.tsv`)
  }

  if (entries.length === 0) {
    return (
      <section className="space-y-3">
        <SectionLabel>Run history</SectionLabel>
        <div className="border border-dashed px-4 py-5">
          <p className="text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            no archived runs
          </p>
          <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
            select past runs here to compare profiles
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <SectionLabel
        right={
          <button
            type="button"
            className="shrink-0 p-1 text-muted-foreground/60 transition-colors hover:text-vermilion"
            onClick={onClear}
            title="Clear all history"
            aria-label="Clear all history"
          >
            <Trash2 className="size-3.5" />
          </button>
        }
      >
        Run history <span className="font-mono text-[9px] text-muted-foreground/70 tnum">{entries.length}</span>
      </SectionLabel>

      <div className="divide-y border border-border bg-card">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-accent/50"
          >
            <Checkbox
              checked={selectedIds.has(entry.id)}
              onCheckedChange={() => onToggleSelect(entry.id)}
              className="size-[13px] rounded-none"
              aria-label={`Compare ${entry.label}`}
            />
            <span aria-hidden className="size-2.5 shrink-0" style={{ background: entry.color }} />
            <div className="min-w-0 flex-1 overflow-hidden">
              <p className="truncate font-mono text-[10px] font-medium text-foreground">{entry.label}</p>
              <p className="truncate font-mono text-[9px] text-muted-foreground tnum">
                r<sub>min</sub> {entry.summary.min_radius?.toFixed(2) ?? '—'} å · {entry.summary.g_macro?.toFixed(0) ?? '—'} pS
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 p-0.5 text-muted-foreground/50 transition-colors hover:text-vermilion"
              onClick={() => onRemove(entry.id)}
              aria-label={`Remove ${entry.label}`}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>

      {selectedEntries.length >= 1 && (
        <div className="flex gap-1.5">
          {selectedEntries.length >= 2 && (
            <Button
              variant={showCompare ? 'default' : 'outline'}
              size="sm"
              className="h-7 flex-1 gap-1.5 rounded-none font-mono text-[10px] uppercase tracking-wider"
              onClick={() => setShowCompare(!showCompare)}
            >
              <GitCompare className="size-3" />
              {showCompare ? 'hide' : `compare ${selectedEntries.length}`}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1.5 rounded-none font-mono text-[10px] uppercase tracking-wider"
            onClick={handleExport}
          >
            <Download className="size-3" /> tsv
          </Button>
        </div>
      )}

      {/* Comparison chart — only shown when 2+ selected and Compare clicked */}
      {showCompare && selectedEntries.length >= 2 && (
        <div className="border border-border bg-card p-2">
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={compareData} margin={{ top: 12, right: 8, bottom: 24, left: -8 }}>
                <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={{ fontSize: 9, fill: 'currentColor', fillOpacity: 0.6 }}
                  stroke="currentColor"
                  strokeOpacity={0.25}
                  tickLine={false}
                  label={{
                    value: 'distance from constriction (å)',
                    position: 'insideBottom',
                    offset: -12,
                    style: { fontSize: 9, fill: 'currentColor', fillOpacity: 0.6 },
                  }}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'currentColor', fillOpacity: 0.6 }}
                  stroke="currentColor"
                  strokeOpacity={0.25}
                  tickLine={false}
                  width={34}
                  label={{
                    value: 'R (å)',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 9, fill: 'currentColor', fillOpacity: 0.6 },
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
                  }}
                  formatter={(value: number, name: string) => [`${value?.toFixed(3)} å`, name]}
                  labelFormatter={(label: number) => `t = ${label.toFixed(1)} å`}
                />
                <ReferenceLine y={HOLE_NARROW} stroke="#B5401F" strokeDasharray="4 2" strokeOpacity={0.4} />
                <ReferenceLine y={HOLE_MAX_GREEN} stroke="#1F3A5F" strokeDasharray="4 2" strokeOpacity={0.4} />
                <ReferenceLine x={0} stroke="#B5401F" strokeOpacity={0.5}
                  label={{ value: 'min r', position: 'top', fontSize: 9, fill: '#B5401F' }} />
                {selectedEntries.map((entry) => (
                  <Line
                    key={entry.id}
                    type="monotone"
                    dataKey={entry.label}
                    stroke={entry.color}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  )
}
