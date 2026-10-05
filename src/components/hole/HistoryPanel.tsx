'use client'

import { useState, useMemo } from 'react'
import { History, Trash2, Download, X, GitCompare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Legend,
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
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="size-4 text-muted-foreground" />
            Run History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-xs text-muted-foreground">
            No history yet. Run HOLE2 to build a comparison library.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {/* History list — compact, no overflow */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              Run History
              <Badge variant="secondary" className="text-[10px]">{entries.length}</Badge>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onClear}
              title="Clear all"
            >
              <Trash2 className="size-3" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2 py-1.5"
              >
                <Checkbox
                  checked={selectedIds.has(entry.id)}
                  onCheckedChange={() => onToggleSelect(entry.id)}
                />
                <div className="size-2.5 shrink-0 rounded-sm" style={{ background: entry.color }} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <p className="truncate text-[11px] font-medium">{entry.label}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    R<sub>min</sub>: {entry.summary.min_radius?.toFixed(2) ?? '—'} Å · {entry.summary.g_macro?.toFixed(0) ?? '—'} pS
                  </p>
                </div>
                <button
                  className="shrink-0 text-muted-foreground hover:text-red-500"
                  onClick={() => onRemove(entry.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>

          {/* Action buttons — always visible at bottom of the list */}
          {selectedEntries.length >= 1 && (
            <div className="mt-2 flex gap-2">
              {selectedEntries.length >= 2 && (
                <Button
                  variant={showCompare ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 flex-1 gap-1.5 text-xs"
                  onClick={() => setShowCompare(!showCompare)}
                >
                  <GitCompare className="size-3" />
                  {showCompare ? 'Hide Comparison' : `Compare ${selectedEntries.length} Runs`}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={handleExport}
              >
                <Download className="size-3" />
                Export TSV
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Comparison chart — only shown when 2+ selected and Compare clicked */}
      {showCompare && selectedEntries.length >= 2 && (
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitCompare className="size-4 text-muted-foreground" />
              Profile Comparison
              <Badge variant="secondary" className="text-[10px]">{selectedEntries.length} runs</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[35vh] min-h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={compareData} margin={{ top: 8, right: 12, bottom: 28, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.7 }}
                    stroke="currentColor"
                    strokeOpacity={0.3}
                    label={{
                      value: 'Distance from constriction (Å)',
                      position: 'insideBottom',
                      offset: -14,
                      style: { fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 },
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'currentColor', fillOpacity: 0.7 }}
                    stroke="currentColor"
                    strokeOpacity={0.3}
                    width={36}
                    label={{
                      value: 'R (Å)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 },
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'rgba(15, 23, 42, 0.95)',
                      border: '1px solid rgba(148, 163, 184, 0.3)',
                      borderRadius: '6px',
                      color: '#e2e8f0',
                      fontSize: 11,
                    }}
                    formatter={(value: number, name: string) => [`${value?.toFixed(3)} Å`, name]}
                    labelFormatter={(label: number) => `t = ${label.toFixed(1)} Å`}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                  />
                  <ReferenceLine y={HOLE_NARROW} stroke="#dc2626" strokeDasharray="4 2" strokeOpacity={0.4} />
                  <ReferenceLine y={HOLE_MAX_GREEN} stroke="#2563eb" strokeDasharray="4 2" strokeOpacity={0.4} />
                  <ReferenceLine x={0} stroke="#fbbf24" strokeDasharray="3 3" strokeOpacity={0.6}
                    label={{ value: 'min R', position: 'top', fontSize: 9, fill: '#fbbf24', fillOpacity: 0.8 }} />
                  {selectedEntries.map((entry) => (
                    <Line
                      key={entry.id}
                      type="monotone"
                      dataKey={entry.label}
                      stroke={entry.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-red-600" /> &lt;{HOLE_NARROW}Å
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-blue-600" /> &ge;{HOLE_MAX_GREEN}Å
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-yellow-400" /> constriction
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 text-[11px]"
                onClick={handleExport}
              >
                <Download className="size-3" /> TSV
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
