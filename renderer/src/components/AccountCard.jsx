import { memo, useState, useEffect, useRef } from 'react'
import { Play, Trash2, Copy, Tag, GripVertical, ShieldCheck, Loader2, RefreshCw, ClipboardCopy } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { StatusIndicator } from '@/components/StatusIndicator'
import { useToast } from '@/components/ui/toast'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

function formatTime(ts) {
  if (!ts) return 'Never'
  try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(ts)) } catch { return '?' }
}

export const AccountCard = memo(function AccountCard({ account, launchStatus, rank, session, dndEnabled = true, onLaunch, onRemove, onCopySettings, onSetNickname, onCheckSession }) {
  const [sessionState, setSessionState] = useState(null)
  const toast = useToast()
  const mountedRef = useRef(true)
  const isLaunching = launchStatus === 'launching'
  const isRunning = launchStatus === 'running'
  const disabled = isLaunching || isRunning

  useEffect(() => { return () => { mountedRef.current = false } }, [])

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id, disabled: !dndEnabled })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  const riotId = account.displayName || account.username || ''
  const displayName = account.nickname ? `${riotId} (${account.nickname})` : riotId

  const safeSetSession = (state, delayMs) => {
    if (delayMs) {
      setTimeout(() => { if (mountedRef.current) setSessionState(state) }, delayMs)
    } else {
      setSessionState(state)
    }
  }

  const handleCheckSession = async () => {
    safeSetSession('checking')
    try {
      const result = await onCheckSession(account.id)
      if (!mountedRef.current) return
      if (result.valid) {
        safeSetSession('valid')
        toast.success(`Session active for ${riotId}`)
        safeSetSession(null, 8000)
      } else if (result.valid === null) {
        safeSetSession('unknown')
        toast.info(`${riotId}: ${result.reason}`)
        safeSetSession(null, 8000)
      } else {
        safeSetSession('expired')
        toast.error(`${riotId}: ${result.reason || 'Session expired.'}`)
        safeSetSession(null, 15000)
      }
    } catch {
      if (!mountedRef.current) return
      safeSetSession('expired')
      toast.error(`${riotId}: Failed to check session.`)
      safeSetSession(null, 15000)
    }
  }

  const handleCopyRiotId = async () => {
    try {
      await navigator.clipboard.writeText(riotId)
      toast.success(`Copied ${riotId}`)
    } catch {
      toast.error('Could not copy to clipboard.')
    }
  }

  // Session stats: today's W/L + RR delta. Wins are green, losses are red,
  // RR delta uses a directional arrow plus the matching color so the sign
  // is legible even for colorblind users.
  const hasSession = session && session.games > 0
  const rrArrow = session && session.rrDelta
    ? (session.rrDelta > 0 ? `↑${session.rrDelta}` : `↓${Math.abs(session.rrDelta)}`)
    : null

  return (
    <div ref={setNodeRef} style={style} className="flex items-center py-3 px-1 group animate-fade-in overflow-hidden">
      <button {...attributes} {...listeners} className={`text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0 mr-2 ${dndEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed opacity-30'}`}>
        <GripVertical className="h-4 w-4" />
      </button>

      {rank?.current?.icon && (
        <img
          src={rank.current.icon}
          alt={rank.current.name}
          className="h-7 w-7 shrink-0 mr-2"
        />
      )}

      <div className="min-w-0 flex-1 overflow-hidden mr-2">
        <p className="text-sm font-medium truncate" title={displayName}>
          {riotId}
          {account.nickname && <span className="text-muted-foreground font-normal text-xs"> ({account.nickname})</span>}
        </p>
        <div className="flex items-center gap-2 mt-0.5 h-4 whitespace-nowrap">
          <span className="text-xs text-muted-foreground">{account.region || 'N/A'}</span>
          <span className="text-xs text-muted-foreground">{formatTime(account.lastUsed)}</span>
          {rank?.current?.name && (
            <span className="text-xs text-foreground truncate font-medium">
              {rank.current.name}
              {rank.current.rr != null && (
                <span className="text-purple-400 font-semibold ml-1">{rank.current.rr} RR</span>
              )}
            </span>
          )}
          {hasSession && (
            <span className="text-xs truncate flex items-center gap-1">
              <span className="text-muted-foreground/60">·</span>
              <span className="text-green-500 font-semibold">{session.wins}W</span>
              <span className="text-red-500 font-semibold">{session.losses}L</span>
              {rrArrow && (
                <span className={session.rrDelta > 0 ? 'text-green-500 font-semibold' : 'text-red-500 font-semibold'}>
                  {rrArrow} RR
                </span>
              )}
            </span>
          )}
          <StatusIndicator status={launchStatus} />
        </div>
      </div>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCheckSession} disabled={sessionState === 'checking'} title="Check session">
          {sessionState === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> :
           sessionState === 'valid' ? <ShieldCheck className="h-3.5 w-3.5 text-purple-500" /> :
           sessionState === 'unknown' ? <ShieldCheck className="h-3.5 w-3.5 text-amber-500" /> :
           sessionState === 'expired' ? <RefreshCw className="h-3.5 w-3.5 text-destructive" /> :
           <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleCopyRiotId} title="Copy Riot ID">
          <ClipboardCopy className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => onSetNickname(account)} title="Set nickname">
          <Tag className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => onCopySettings(account)} title="Copy settings">
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Account</AlertDialogTitle>
              <AlertDialogDescription>
                Remove "<span className="text-purple-400 font-medium">{riotId}</span>"
                {account.nickname ? <span className="text-muted-foreground"> ({account.nickname})</span> : null}
                {' '}from Nebula? The saved session will be deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRemove(account.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <Button size="sm" onClick={() => onLaunch(account.id)} disabled={disabled} className="gap-1.5 min-w-[90px] justify-center shrink-0 ml-1">
        <Play className="h-3 w-3" />
        {isLaunching ? 'Launching' : isRunning ? 'Running' : 'Launch'}
      </Button>
    </div>
  )
})
