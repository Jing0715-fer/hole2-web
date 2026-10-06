'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Package, AlertCircle, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/hole/SectionLabel'
import type { RunResult } from '@/lib/hole/types'
import { downloadUrl, downloadZipUrl, describeFile, fetchJobFiles, type JobFile } from '@/lib/hole/api'

/** Best-effort file-size estimate from the result payload (avoids an extra
 *  round-trip to /api/job/{id}/files just to show sizes). */
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

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-[7px]">
      <span className="protocol-label">{label}</span>
      <span
        className={
          'font-mono text-[11px] font-medium tnum ' +
          (accent ? 'text-vermilion' : 'text-foreground')
        }
      >
        {value}
      </span>
    </div>
  )
}

interface ResultsPanelProps {
  result: RunResult | null
  loading: boolean
  error: string | null
}

export function ResultsPanel({ result, loading, error }: ResultsPanelProps) {
  // Estimated sizes render immediately; real sizes arrive from the job
  // endpoint right after (they include the multi-MB input PDB, which no
  // client-side estimate can know).
  const estimated: JobFile[] = useMemo(() => {
    if (!result) return []
    return result.files.map((name) => {
      const size = guessFileSize(result, name)
      return { name, size }
    })
  }, [result])

  // Real sizes arrive from the job endpoint right after a run (they include
  // the multi-MB input PDB, which no client-side estimate can know). Keyed by
  // job id so a new result naturally falls back to the estimates below.
  const [fetched, setFetched] = useState<{ jobId: string; files: JobFile[] } | null>(null)
  useEffect(() => {
    if (!result) return
    let cancelled = false
    fetchJobFiles(result.job_id)
      .then((files) => { if (!cancelled) setFetched({ jobId: result.job_id, files }) })
      .catch(() => { /* keep the estimates */ })
    return () => { cancelled = true }
  }, [result])

  const files: JobFile[] =
    result && fetched?.jobId === result.job_id ? fetched.files : estimated

  if (loading) {
    return (
      <section className="space-y-3">
        <SectionLabel>Readout</SectionLabel>
        <div className="border bg-card px-4 py-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-foreground">
              tracing<span className="anim-dots">…</span>
            </p>
            <ol className="space-y-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
              <li>01 · monte-carlo pore search</li>
              <li>02 · sphere optimisation</li>
              <li>03 · surface triangulation</li>
            </ol>
          </div>
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="space-y-3">
        <SectionLabel>Readout</SectionLabel>
        <div className="border-l-2 border-vermilion bg-vermilion/[0.05] px-3.5 py-3">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-vermilion">
            <OctagonAlert className="size-3.5" /> run failed
          </p>
          <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-foreground/80">
            {error}
          </p>
        </div>
      </section>
    )
  }

  if (!result) {
    return (
      <section className="space-y-3">
        <SectionLabel>Readout</SectionLabel>
        <div className="border border-dashed px-4 py-6">
          <p className="text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            no measurement yet
          </p>
          <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
            run HOLE2 to populate the readout
          </p>
        </div>
      </section>
    )
  }

  const s = result.summary
  const fmt = (n: number | null | undefined, d = 3) => n == null ? '—' : n.toFixed(d)
  const isNoPore = s.status === 'no_pore' || s.status === 'error'

  return (
    <section className="space-y-4">
      <SectionLabel
        right={
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
            job {result.job_id}
          </span>
        }
      >
        Readout
      </SectionLabel>

      {/* No-pore guidance — HOLE completed but traced nothing */}
      {isNoPore && (
        <div className="border-l-2 border-vermilion bg-vermilion/[0.05] px-3.5 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-vermilion">
            no pore traced
          </p>
          <div className="mt-2 space-y-1.5">
            {(result.warnings?.length ? result.warnings : ['HOLE completed but could not trace a pore with the current parameters.']).map((w, i) => (
              <p key={i} className="text-[11px] leading-relaxed text-foreground/75">
                {w}
              </p>
            ))}
          </div>
          {s.cguess_direction && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              auto-guessed direction: <b className="text-foreground">{s.cguess_direction}</b>
            </p>
          )}
        </div>
      )}

      {/* Non-fatal warnings (e.g. sos_triangle polygon overflow on large pores) */}
      {!isNoPore && result.warnings && result.warnings.length > 0 && (
        <div className="border-l-2 border-ochre bg-muted/50 px-3.5 py-2.5">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <AlertCircle className="size-3.5" /> notice
          </p>
          <div className="mt-1 space-y-1">
            {result.warnings.map((w, i) => (
              <p key={i} className="text-[11px] leading-relaxed text-foreground/75">{w}</p>
            ))}
          </div>
        </div>
      )}

      {/* Headline — minimum radius (hidden for failed traces; the guidance above stands alone) */}
      {!isNoPore && (
      <div className="border bg-card">
        <div className="flex items-baseline justify-between px-3 pb-0.5 pt-2.5">
          <span className="protocol-label">minimum radius</span>
          {s.min_t != null && (
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground tnum">
              at t = {s.min_t.toFixed(2)} å
            </span>
          )}
        </div>
        <p className="px-3 pb-2.5 pt-0.5 font-mono text-[30px] leading-none font-medium tracking-tight text-vermilion tnum">
          {s.min_radius != null ? s.min_radius.toFixed(3) : '—'}
          <span className="ml-1.5 align-baseline font-mono text-[13px] font-normal text-muted-foreground">Å</span>
        </p>
        <div className="border-t px-3 py-2">
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {s.n_spheres ?? 0} spheres sampled · {s.n_samples ?? 0} profile points ·{' '}
            {s.n_triangles ?? 0} triangles
          </p>
        </div>
      </div>
      )}

      {/* Secondary measurements */}
      {!isNoPore && (
      <div className="divide-y border border-border bg-card">
        <Row label="pore length" value={`${fmt(s.pore_length, 2)} å`} />
        <Row label="maximum radius" value={`${fmt(s.max_radius, 3)} å`} />
        <Row label="conductance F" value={fmt(s.g_factor, 3)} />
        <Row label="G macro" value={s.g_macro != null ? `${s.g_macro.toFixed(1)} pS` : '—'} />
      </div>
      )}

      {/* Output files */}
      <SectionLabel
        right={
          files.length > 0 ? (
            <a
              href={downloadZipUrl(result.job_id)}
              download={`hole2-${result.job_id}.zip`}
              className="inline-flex shrink-0 items-center gap-1 border bg-card px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground transition-colors hover:border-foreground"
            >
              <Package className="size-3" /> zip
            </a>
          ) : undefined
        }
      >
        Output files
      </SectionLabel>
      <div className="divide-y border border-border bg-card">
        {files.map((f) => (
          <a
            key={f.name}
            href={downloadUrl(result.job_id, f.name)}
            download={f.name}
            className="group flex items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-accent"
          >
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="size-3.5 shrink-0 text-muted-foreground/70" />
              <div className="min-w-0">
                <p className="truncate font-mono text-[11px] text-foreground">{f.name}</p>
                <p className="truncate text-[9px] leading-tight text-muted-foreground">{describeFile(f.name)}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-[9px] text-muted-foreground tnum">{(f.size / 1024).toFixed(1)} KB</span>
              <Download className="size-3 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
            </div>
          </a>
        ))}
      </div>

      {/* Log tail */}
      <SectionLabel>Engine log · tail</SectionLabel>
      <pre className="max-h-44 overflow-auto border bg-foreground/[0.045] p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {result.log_tail}
      </pre>
    </section>
  )
}
