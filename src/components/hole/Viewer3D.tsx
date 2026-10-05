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
 */
export function Viewer3D({ pdbText, pdbName, spheres, surface, centreline, options, bgColor, onReady }: Viewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HoleViewer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // mount once
  useEffect(() => {
    if (!containerRef.current) return

    // Wait for three.js to load from the CDN (layout.tsx adds the script tag)
    let cancelled = false
    const initViewer = () => {
      if (cancelled || !containerRef.current) return
      const w = window as any
      if (!w.THREE) {
        // Retry in 100ms until three.js is loaded
        setTimeout(initViewer, 100)
        return
      }
      try {
        const v = new HoleViewer(containerRef.current)
        viewerRef.current = v
        onReady?.(v)
      } catch (e) {
        console.error('Failed to init 3D viewer:', e)
        const errMsg = String(e)
        queueMicrotask(() => setLoadError(errMsg))
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
  }, [bgColor])

  // load structure
  useEffect(() => {
    const v = viewerRef.current
    if (!v || !pdbText) return
    try {
      v.loadStructure(pdbText, pdbName)
    } catch (e) {
      console.error('loadStructure error:', e)
      const errMsg = String(e)
      queueMicrotask(() => setLoadError(errMsg))
    }
  }, [pdbText, pdbName])

  // load hole results
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    try {
      v.loadHoleResults(spheres, surface, centreline)
    } catch (e) {
      console.error('loadHoleResults error:', e)
    }
  }, [spheres, surface, centreline])

  // option changes
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.setOptions(options)
  }, [options])

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-rose-400">
        <p className="text-sm font-medium">3D viewer error</p>
        <p className="text-xs opacity-70 break-words">{loadError}</p>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

export type { HoleViewerOptions }
