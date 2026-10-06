'use client'

import { Loader2, AlertCircle, Download, FileText, Route, TrendingDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import type { CaverResult } from '@/lib/caver/types'
import { CAVER_CLUSTER_COLORS } from '@/lib/caver/types'
import { caverFileUrl } from '@/lib/caver/api'

interface CaverResultsPanelProps {
  result: CaverResult | null
  loading: boolean
  error: string | null
}

export function CaverResultsPanel({ result, loading, error }: CaverResultsPanelProps) {
  if (loading) {
    return (
      <Card className="border-border/60">
        <CardContent className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Searching for tunnels…
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-rose-400/40">
        <CardContent className="flex items-start gap-2 py-4 text-xs text-rose-500">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Analysis failed</p>
            <p className="mt-1 opacity-80 break-words">{error}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!result) {
    return null
  }

  const { summary, clusters, tunnels, job_id, files, warnings } = result

  return (
    <div className="space-y-3">
      {/* Summary card */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Route className="size-4 text-emerald-500" />
            CAVER Results
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Key metrics */}
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Tunnels found" value={String(summary.n_tunnels)} />
            <Metric label="Clusters" value={String(summary.n_clusters)} />
            <Metric
              label="Max bottleneck"
              value={summary.max_bottleneck !== null ? `${summary.max_bottleneck.toFixed(3)} Å` : '—'}
            />
            <Metric
              label="Min bottleneck"
              value={summary.min_bottleneck !== null ? `${summary.min_bottleneck.toFixed(3)} Å` : '—'}
            />
          </div>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-400/40 bg-amber-50/50 p-2 dark:bg-amber-950/20">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <AlertCircle className="size-3" />
                Warnings
              </div>
              <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Cluster table */}
          {clusters.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Cluster summary
                </p>
                <Badge variant="secondary" className="text-[10px]">{clusters.length} clusters</Badge>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border/40">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left">
                      <th className="px-1.5 py-1 font-medium">#</th>
                      <th className="px-1.5 py-1 font-medium">Tun</th>
                      <th className="px-1.5 py-1 font-medium">Avg BN</th>
                      <th className="px-1.5 py-1 font-medium">Max BN</th>
                      <th className="px-1.5 py-1 font-medium">Avg L</th>
                      <th className="px-1.5 py-1 font-medium">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clusters.map((c) => (
                      <tr key={c.id} className="border-t border-border/30 hover:bg-muted/30">
                        <td className="px-1.5 py-1">
                          <span
                            className="inline-flex size-3 rounded-sm"
                            style={{ background: CAVER_CLUSTER_COLORS[(c.id - 1) % CAVER_CLUSTER_COLORS.length] }}
                          />
                          <span className="ml-1 font-mono">{c.id}</span>
                        </td>
                        <td className="px-1.5 py-1 font-mono">{c.n_tunnels}</td>
                        <td className="px-1.5 py-1 font-mono">{c.avg_bottleneck.toFixed(2)}</td>
                        <td className="px-1.5 py-1 font-mono">{c.max_bottleneck.toFixed(2)}</td>
                        <td className="px-1.5 py-1 font-mono">{c.avg_length.toFixed(1)}</td>
                        <td className="px-1.5 py-1 font-mono">{c.priority.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tunnel details */}
          {tunnels.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Tunnel details
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {tunnels.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2.5 rounded-sm"
                        style={{ background: CAVER_CLUSTER_COLORS[(t.cluster_id - 1) % CAVER_CLUSTER_COLORS.length] }}
                      />
                      <span className="text-[11px] font-medium">Tunnel {t.id}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>R<sub>bn</sub>={t.bottleneck_radius.toFixed(2)}Å</span>
                      <span>L={t.length.toFixed(1)}Å</span>
                      <span>C={t.curvature.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator />

          {/* Output files */}
          {files.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Output files
                </p>
                <Button variant="outline" size="sm" className="h-6 gap-1 text-[10px]" asChild>
                  <a
                    href={`/api/caver/job/${job_id}/files?path=out/log.txt`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText className="size-3" /> log.txt
                  </a>
                </Button>
              </div>
              <div className="max-h-24 space-y-0.5 overflow-y-auto">
                {files.slice(0, 8).map((f) => (
                  <a
                    key={f}
                    href={caverFileUrl(job_id, f)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    <Download className="size-2.5 shrink-0" />
                    <span className="truncate">{f}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 px-2 py-1.5">
      <p className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}
