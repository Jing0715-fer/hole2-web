'use client'

import { useEffect, useRef } from 'react'
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

  // mount once
  useEffect(() => {
    if (!containerRef.current) return
    const v = new HoleViewer(containerRef.current)
    viewerRef.current = v
    onReady?.(v)
    return () => {
      v.dispose()
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
    v.loadStructure(pdbText, pdbName)
  }, [pdbText, pdbName])

  // load hole results
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.loadHoleResults(spheres, surface, centreline)
  }, [spheres, surface, centreline])

  // option changes
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.setOptions(options)
  }, [options])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
