import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Section label — the app's editorial signature.
 * Tiny mono uppercase text with a hairline rule running to the edge,
 * like the numbered steps of a lab protocol.
 */
export function SectionLabel({
  children,
  right,
  className,
}: {
  children: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="protocol-label whitespace-nowrap">{children}</span>
      <span className="h-px min-w-4 flex-1 bg-border" />
      {right}
    </div>
  )
}
