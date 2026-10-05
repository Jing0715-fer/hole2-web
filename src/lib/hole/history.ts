/**
 * Run history store — persists HOLE2 run results to localStorage so the user
 * can compare pore profiles across multiple runs.
 *
 * Each history entry stores:
 *   - id: unique run ID (from the API job_id)
 *   - label: human-readable name (e.g. "1grm · simple.rad · endrad 5.0")
 *   - timestamp: when the run was executed
 *   - params: the RunParams used for this run
 *   - profile: the parsed PoreProfile (samples, min_r, g_macro, etc.)
 *   - summary: key stats (min_radius, pore_length, g_factor, g_macro)
 *   - color: assigned chart color for this run
 */

import type { PoreProfile, RunSummary, RunParams } from './types'

export interface HistoryEntry {
  id: string
  label: string
  timestamp: number
  params: RunParams
  profile: PoreProfile
  summary: RunSummary
  color: string
  pdbName: string
}

const STORAGE_KEY = 'hole2-run-history'
const MAX_ENTRIES = 20

// Color palette for multi-run comparison
const COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
]

/** Load all history entries from localStorage. */
export function loadHistory(): HistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** Save history entries to localStorage (capped at MAX_ENTRIES). */
export function saveHistory(entries: HistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    const trimmed = entries.slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage might be full — try saving with fewer entries
    try {
      const trimmed = entries.slice(0, 5)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } catch { /* give up silently */ }
  }
}

/** Add a new run to the history. Returns the updated list. */
export function addToHistory(
  entries: HistoryEntry[],
  run: {
    id: string
    pdbName: string
    params: RunParams
    profile: PoreProfile
    summary: RunSummary
  },
): HistoryEntry[] {
  const color = COLORS[entries.length % COLORS.length]
  const label = makeLabel(run.pdbName, run.params)
  const entry: HistoryEntry = {
    id: run.id,
    label,
    timestamp: Date.now(),
    params: run.params,
    profile: run.profile,
    summary: run.summary,
    color,
    pdbName: run.pdbName,
  }
  // Remove duplicate (same id) if exists
  const filtered = entries.filter(e => e.id !== run.id)
  const updated = [entry, ...filtered].slice(0, MAX_ENTRIES)
  saveHistory(updated)
  return updated
}

/** Remove a run from history by ID. */
export function removeFromHistory(entries: HistoryEntry[], id: string): HistoryEntry[] {
  const updated = entries.filter(e => e.id !== id)
  saveHistory(updated)
  return updated
}

/** Clear all history. */
export function clearHistory(): HistoryEntry[] {
  saveHistory([])
  return []
}

/** Generate a human-readable label for a run. */
function makeLabel(pdbName: string, params: RunParams): string {
  const name = pdbName.replace(/\.(pdb|cif)$/i, '')
  const rad = params.radius_set || 'simple'
  const endrad = params.endrad || '5.0'
  const parts = [name, `${rad}.rad`, `endrad ${endrad}`]
  if (params.connolly) parts.push('connolly')
  if (params.cvect_z) parts.push(`cvect ${params.cvect_z}`)
  return parts.join(' · ')
}

/** Export selected history entries as TSV for use in spreadsheets. */
export function exportComparisonTSV(entries: HistoryEntry[]): string {
  // Find the union of all t-values across all entries
  const allT = new Set<number>()
  for (const entry of entries) {
    for (const s of entry.profile.samples) {
      allT.add(Number(s.t.toFixed(3)))
    }
  }
  const sortedT = Array.from(allT).sort((a, b) => a - b)

  // Build TSV: first column = t, then one column per entry
  const header = ['t (Å)']
  for (const entry of entries) {
    header.push(entry.label)
  }

  const rows: string[] = [header.join('\t')]
  for (const t of sortedT) {
    const row: string[] = [t.toFixed(3)]
    for (const entry of entries) {
      // Find the sample with this t value (or interpolate)
      const samples = entry.profile.samples
      // Find closest sample
      let bestR = ''
      let bestDist = Infinity
      for (const s of samples) {
        const d = Math.abs(s.t - t)
        if (d < bestDist) {
          bestDist = d
          bestR = s.r.toFixed(4)
        }
      }
      row.push(bestDist < 0.2 ? bestR : '') // only show if within 0.2 Å
    }
    rows.push(row.join('\t'))
  }

  // Add summary section
  rows.push('')
  rows.push('=== Summary ===')
  rows.push(['Run', 'Min R (Å)', 'Max R (Å)', 'Pore Length (Å)', 'G Factor', 'G_macro (pS)'].join('\t'))
  for (const entry of entries) {
    rows.push([
      entry.label,
      entry.summary.min_radius?.toFixed(4) ?? '',
      entry.summary.max_radius?.toFixed(4) ?? '',
      entry.summary.pore_length?.toFixed(2) ?? '',
      entry.summary.g_factor?.toFixed(4) ?? '',
      entry.summary.g_macro?.toFixed(2) ?? '',
    ].join('\t'))
  }

  return rows.join('\n')
}

/** Trigger a download of a text string as a file. */
export function downloadTSV(tsv: string, filename = 'hole2-comparison.tsv'): void {
  if (typeof window === 'undefined') return
  const blob = new Blob([tsv], { type: 'text/tab-separated-values' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
