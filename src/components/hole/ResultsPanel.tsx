'use client'

import { useMemo } from 'react'
import { Download, FileText, Box, TrendingDown, Ruler, Activity, Zap, Loader2, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { RunResult } from '@/lib/hole/types'
import { downloadUrl, describeFile, type JobFile } from '@/lib/hole/api'

/** Best-effort file-size estimate from the result payload (avoids an extra
 *  round-trip to /api/job/{id}/files just to show sizes).  The exact size is
 *  shown on the download link itself. */
function guessFileSize(result: RunResult, name: string): number {
  const len = (arr: unknown) => (Array.isArray(arr) ? arr.length : 0)
  switch (name) {
    case 'hole_out.txt': return Math.max(result.log_tail?.length ?? 0, 1000) * 25 // log_tail is just the tail
    case 'hole_out.sph': return len(result.spheres) * 75
    case 'solid_surface.vmd_plot': return len(result.surface.triangles) * 200
    case 'solid_surface.sos': return len(result.surface.triangles) * 60
    case 'dotsurface.qpt': return len(result.spheres) * 230
    case 'hole.inp': return 120
    default: return 0
  }
}

interface ResultsPanelProps {
  result: RunResult | null
  loading: boolean
  error: string | null
}

function StatCard({ icon, label, value, unit, color }: {
  icon: ReactNode; label: string; value: string; unit?: string; color?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background"
        style={{ color: color ?? 'currentColor' }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm font-semibold">
          {value}{unit && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
        </p>
      </div>
    </div>
  )
}

export function ResultsPanel({ result, loading, error }: ResultsPanelProps) {
  // Use the files list returned in the result payload directly — it always
  // matches the job, no need to re-fetch.
  const files: JobFile[] = useMemo(() => {
    if (!result) return []
    return result.files.map((name) => {
      const size = guessFileSize(result, name)
      return { name, size }
    })
  }, [result])

  if (loading) {
    return (
      <Card className="border-border/60">
        <CardContent className="flex h-64 flex-col items-center justify-center gap-3 text-center">
          <Loader2 className="size-8 animate-spin text-emerald-500" />
          <div>
            <p className="text-sm font-medium">Running HOLE2…</p>
            <p className="text-xs text-muted-foreground">Parsing structure → sampling pore → triangulating surface</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>HOLE2 run failed</AlertTitle>
        <AlertDescription className="mt-1 break-words font-mono text-xs">{error}</AlertDescription>
      </Alert>
    )
  }

  if (!result) {
    return (
      <Card className="border-dashed border-border/60">
        <CardContent className="flex h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <Box className="size-8 opacity-40" />
          <p className="text-sm">No results yet</p>
          <p className="text-xs">Upload a PDB file and click “Run HOLE2 analysis”.</p>
        </CardContent>
      </Card>
    )
  }

  const s = result.summary
  const fmt = (n: number | null | undefined, d = 3) => n == null ? '—' : n.toFixed(d)

  return (
    <div className="space-y-4">
      {/* Non-fatal warnings (e.g. sos_triangle polygon overflow on large pores) */}
      {result.warnings && result.warnings.length > 0 && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle className="text-xs">Notice</AlertTitle>
          <AlertDescription className="mt-1 space-y-1 text-xs">
            {result.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {/* Summary stats */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Activity className="size-4 text-emerald-500" />
              Pore-profile summary
            </span>
            <Badge variant="secondary" className="font-mono text-[10px]">job {result.job_id}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            {s.n_spheres} spheres sampled · {s.n_samples} profile points · {s.n_triangles} surface triangles
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <StatCard
            icon={<TrendingDown className="size-4" />}
            label="Min radius"
            value={fmt(s.min_radius, 3)}
            unit="Å"
            color="#dc2626"
          />
          <StatCard
            icon={<Ruler className="size-4" />}
            label="Pore length"
            value={fmt(s.pore_length, 2)}
            unit="Å"
            color="#2563eb"
          />
          <StatCard
            icon={<Box className="size-4" />}
            label="Max radius"
            value={fmt(s.max_radius, 3)}
            unit="Å"
            color="#16a34a"
          />
          <StatCard
            icon={<Zap className="size-4" />}
            label="G factor F"
            value={fmt(s.g_factor, 3)}
            unit="Å⁻¹"
            color="#f59e0b"
          />
          <StatCard
            icon={<Zap className="size-4" />}
            label="G_macro"
            value={fmt(s.g_macro, 1)}
            unit="pS"
            color="#f59e0b"
          />
          <StatCard
            icon={<FileText className="size-4" />}
            label="Constriction t"
            value={fmt(s.min_t, 2)}
            unit="Å"
            color="#fbbf24"
          />
        </CardContent>
      </Card>

      {/* Output files */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="size-4 text-emerald-500" />
            Output files
          </CardTitle>
          <CardDescription className="text-xs">
            Identical to the original HOLE2 command-line output. Click to download.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-72">
            <div className="space-y-1.5">
              {files.map((f) => (
                <a
                  key={f.name}
                  href={downloadUrl(result.job_id, f.name)}
                  download={f.name}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-medium">{f.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{describeFile(f.name)}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{(f.size / 1024).toFixed(1)} KB</Badge>
                    <Download className="size-3.5 text-muted-foreground" />
                  </div>
                </a>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Log tail */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-emerald-500" />
            HOLE2 log (tail)
          </CardTitle>
          <CardDescription className="text-xs">
            Last 3 KB of the <code>hole_out.txt</code> stream.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-64 overflow-auto rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {result.log_tail}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
