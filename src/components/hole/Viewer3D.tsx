'use client'

import { useEffect, useRef, useState } from 'react'
import { HoleViewer, type HoleViewerOptions } from '@/lib/hole/viewer'
import type { HoleSphere, HoleSurface } from '@/lib/hole/types'

interface Viewer3DProps {
  pdbText: string | null
  pdbName: string
  spheres: HoleSphere[]
  surface: HoleSurface
  centreline: [number, number, number][]
  options: HoleViewerOptions
  bgColor: string  // hex like '#0b1220'
  onReady?: (viewer: HoleViewer) => void
}

/**
 * 3D viewer panel — mounts the three.js canvas, loads the PDB structure
 * + HOLE surface whenever the inputs change, and forwards option changes.
 *
 * The three.js library is loaded from a CDN script tag (layout.tsx), so the
 * viewer initialisation retries until `window.THREE` appears. Inputs that
 * arrive before the viewer is ready (structure text, HOLE results, option
 * changes) are stored in refs and replayed right after initialisation so a
 * slow CDN never silently drops a structure load.
 */
export function Viewer3D({ pdbText, pdbName, spheres, surface, centreline, options, bgColor, onReady }: Viewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HoleViewer | null>(null)
  // Error state is stored together with the pdbText it belongs to, so a new
  // structure automatically clears the previous error without needing a
  // setState call inside an effect (React-compiler-friendly).
  const [errorState, setErrorState] = useState<{ msg: string; forText: string } | null>(null)
  const loadError = errorState && errorState.forText === pdbText ? errorState.msg : null
  const [viewerReady, setViewerReady] = useState(false)

  // Latest inputs — read by the init effect to replay pending state.
  const pdbTextRef = useRef(pdbText)
  const pdbNameRef = useRef(pdbName)
  const resultsRef = useRef({ spheres, surface, centreline })
  const optionsRef = useRef(options)
  const onReadyRef = useRef(onReady)

  // Keep the refs in sync (in an effect — not during render — so the React
  // compiler stays happy).
  useEffect(() => {
    pdbTextRef.current = pdbText
    pdbNameRef.current = pdbName
    resultsRef.current = { spheres, surface, centreline }
    optionsRef.current = options
    onReadyRef.current = onReady
  }, [pdbText, pdbName, spheres, surface, centreline, options, onReady])

  // mount once
  useEffect(() => {
    if (!containerRef.current) return

    // Wait for three.js to load from the CDN (layout.tsx adds the script tag)
    let cancelled = false
    const initViewer = () => {
      if (cancelled || !containerRef.current) return
      const w = window as any
      if (!w.THREE || !w.THREE.TrackballControls) {
        // Retry in 100ms until three.js is loaded. Give up (with a visible
        // error) after ~30 s so the user is never left staring at a black box.
        if (!initViewer.elapsed) initViewer.elapsed = 0
        initViewer.elapsed += 100
        if (initViewer.elapsed > 30000) {
          queueMicrotask(() => setErrorState({
            msg: 'three.js failed to load from the CDN within 30 s — check your network and reload.',
            forText: pdbTextRef.current ?? '',
          }))
          return
        }
        setTimeout(initViewer, 100)
        return
      }
      try {
        const v = new HoleViewer(containerRef.current)
        viewerRef.current = v
        // Replay any state that arrived while the CDN script was loading —
        // without this a structure picked during the window would never be
        // loaded (the effects below no-op'd on the null viewer).
        try {
          if (pdbTextRef.current) {
            v.loadStructure(pdbTextRef.current, pdbNameRef.current)
          }
          const r = resultsRef.current
          if (r.spheres.length || r.surface.triangles.length || r.centreline.length) {
            v.loadHoleResults(r.spheres, r.surface, r.centreline)
          }
          v.setOptions(optionsRef.current)
        } catch (e) {
          console.error('replay-after-init error:', e)
        }
        onReadyRef.current?.(v)
        queueMicrotask(() => setViewerReady(true))
      } catch (e) {
        console.error('Failed to init 3D viewer:', e)
        const errMsg = String(e)
        queueMicrotask(() => setErrorState({ msg: errMsg, forText: pdbTextRef.current ?? '' }))
      }
    }
    initViewer()

    return () => {
      cancelled = true
      const v = viewerRef.current
      if (v) {
        try { v.dispose() } catch { /* noop */ }
      }
      viewerRef.current = null
    }
  }, [])

  // background colour
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.setBackground(parseInt(bgColor.replace('#', '0x'), 16))
  }, [bgColor, viewerReady])

  // load structure — errors are tagged with the pdbText they belong to, so
  // loading a different structure automatically clears them.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || !pdbText) return
    try {
      v.loadStructure(pdbText, pdbName)
    } catch (e) {
      console.error('loadStructure error:', e)
      const errMsg = String(e)
      queueMicrotask(() => setErrorState({ msg: errMsg, forText: pdbText }))
    }
  }, [pdbText, pdbName, viewerReady])

  // load hole results
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    try {
      v.loadHoleResults(spheres, surface, centreline)
    } catch (e) {
      console.error('loadHoleResults error:', e)
    }
  }, [spheres, surface, centreline, viewerReady])

  // option changes
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.setOptions(options)
  }, [options, viewerReady])

  // The container stays mounted even on error so the WebGL context can be
  // disposed properly on unmount; the error is shown as an overlay.
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 p-4 text-center text-rose-400 backdrop-blur-sm">
          <p className="text-sm font-medium">3D viewer error</p>
          <p className="max-w-md text-xs opacity-70 break-words">{loadError}</p>
          <button
            type="button"
            className="mt-1 rounded-md border border-rose-400/40 px-3 py-1 text-xs hover:bg-rose-400/10"
            onClick={() => setErrorState(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

export type { HoleViewerOptions }
