import { cn } from '@/lib/utils'

const statusConfig = {
  idle: { color: 'bg-transparent', label: '' },
  launching: { color: 'bg-purple-400 animate-pulse-soft', label: 'Launching...' },
  running: { color: 'bg-purple-500', label: 'Running' },
  closed: { color: 'bg-zinc-400', label: 'Closed' },
  error: { color: 'bg-red-500', label: 'Error' },
}

export function StatusIndicator({ status = 'idle' }) {
  const config = statusConfig[status] || statusConfig.idle
  if (status === 'idle') return <span className="inline-flex items-center gap-1.5 h-4" />

  return (
    <span className="inline-flex items-center gap-1.5 h-4">
      <span className={cn('h-2 w-2 rounded-full shrink-0', config.color)} />
      <span className="text-xs text-muted-foreground">{config.label}</span>
    </span>
  )
}
