'use client'

import { useState, useMemo } from 'react'
import { History, Trash2, Download, Eye, EyeOff, X, GitCompare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
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

  // Build comparison chart data from selected entries with normalized t
  // (constriction point at t=0, so different runs align on the same axis)
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
          <p className="text-xs text-muted-foreground text-center py-4">
            No history yet. Run HOLE2 analysis to build a comparison library.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* History list */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              Run History
              <Badge variant="secondary" className="text-[10px]">{entries.length}</Badge>
            </span>
            <div className="flex items-center gap-1">
              {selectedEntries.length >= 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setShowCompare(!showCompare)}
                >
                  <GitCompare className="size-3" />
                  {showCompare ? 'Hide' : 'Compare'}
                </Button>
              )}
              {selectedEntries.length >= 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={handleExport}
                >
                  <Download className="size-3" />
                  Export TSV
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onClear}
                title="Clear all history"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </CardTitle>
          <CardDescription className="text-xs">
            Select 2+ runs to compare pore profiles side by side.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-48">
            <div className="space-y-1.5">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2.5 py-2"
                >
                  <Checkbox
                    checked={selectedIds.has(entry.id)}
                    onCheckedChange={() => onToggleSelect(entry.id)}
                  />
                  <div className="flex size-3 shrink-0 rounded-sm" style={{ background: entry.color }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{entry.label}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      min R: {entry.summary.min_radius?.toFixed(3) ?? '—'} Å ·
                      {' '}{entry.summary.g_macro?.toFixed(1) ?? '—'} pS ·
                      {' '}{new Date(entry.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0"
                    onClick={() => onRemove(entry.id)}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Comparison chart */}
      {showCompare && selectedEntries.length >= 2 && (
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitCompare className="size-4 text-muted-foreground" />
              Profile Comparison
              <Badge variant="secondary" className="text-[10px]">{selectedEntries.length} runs</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[40vh] min-h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={compareData} margin={{ top: 10, right: 20, bottom: 28, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={{ fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 }}
                    stroke="currentColor"
                    strokeOpacity={0.3}
                    label={{
                      value: 'Distance from constriction (Å)',
                      position: 'insideBottom',
                      offset: -16,
                      style: { fontSize: 12, fill: 'currentColor', fillOpacity: 0.7 },
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'currentColor', fillOpacity: 0.7 }}
                    stroke="currentColor"
                    strokeOpacity={0.3}
                    label={{
                      value: 'Pore radius R (Å)',
                      angle: -90,
                      position: 'insideLeft',
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
                    formatter={(value: number, name: string) => [`${value?.toFixed(3)} Å`, name]}
                    labelFormatter={(label: number) => `t = ${label.toFixed(2)} Å`}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  />
                  <ReferenceLine y={HOLE_NARROW} stroke="#dc2626" strokeDasharray="4 2" strokeOpacity={0.4} />
                  <ReferenceLine y={HOLE_MAX_GREEN} stroke="#2563eb" strokeDasharray="4 2" strokeOpacity={0.4} />
                  {/* Constriction point marker at t=0 (the alignment anchor) */}
                  <ReferenceLine x={0} stroke="#fbbf24" strokeDasharray="3 3" strokeOpacity={0.6}
                    label={{ value: 'constriction', position: 'top', fontSize: 10, fill: '#fbbf24', fillOpacity: 0.8 }} />
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
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-red-600" /> Narrow &lt; {HOLE_NARROW} Å
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-blue-600" /> Wide ≥ {HOLE_MAX_GREEN} Å
                </span>
              </div>
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
          </CardContent>
        </Card>
      )}
    </div>
  )
}
