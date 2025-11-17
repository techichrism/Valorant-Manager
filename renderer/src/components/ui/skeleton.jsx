import { cn } from '@/lib/utils'

// Animated skeleton placeholder. Uses a shimmer gradient that sweeps
// left-to-right via `animate-shimmer`. Drop into any layout as a div stand-in
// for content that hasn't loaded yet.
export function Skeleton({ className, ...props }) {
  return (
    <div
      className={cn(
        'rounded-md bg-gradient-to-r from-secondary/60 via-secondary/40 to-secondary/60 bg-[length:200%_100%] animate-shimmer',
        className
      )}
      {...props}
    />
  )
}
