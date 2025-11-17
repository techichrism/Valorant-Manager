import { useState, useCallback, useMemo } from 'react'
import { Search, History, UserCircle, Ban, ShieldCheck, Loader2, AlertCircle, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'

function formatDate(ts) {
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ts))
  } catch { return '' }
}

// Compact "Mar 2024 – Aug 2024" range. Collapses to a single month when
// both endpoints share it, drops year repetition within a year, and
// uses "present" for the current name.
function formatRange(start, end, isCurrent) {
  if (!start && !end) return ''
  const s = start ? new Date(start) : null
  const e = end ? new Date(end) : null
  const fmt = (d) => new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(d)
  if (isCurrent) {
    return s ? `${fmt(s)} – present` : 'present'
  }
  if (!s || !e) return s ? fmt(s) : fmt(e)
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) {
    return fmt(s)
  }
  if (s.getFullYear() === e.getFullYear()) {
    const monthOnly = (d) => new Intl.DateTimeFormat(undefined, { month: 'short' }).format(d)
    return `${monthOnly(s)} – ${monthOnly(e)} ${e.getFullYear()}`
  }
  return `${fmt(s)} – ${fmt(e)}`
}

// Standalone Riot ID lookup. Resolves name#tag → puuid via Henrikdev,
// then walks the player's stored match history and surfaces every
// distinct gameName the target was seen as. Date ranges come from
// confirmed observations only.
export function PlayerLookupTab({ accounts = [] }) {
  const [riotIdInput, setRiotIdInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const toast = useToast()

  // Resolved puuid matches one of the user's own accounts? Used to hide
  // the blacklist control — blacklisting yourself is never useful and
  // would dump your own Riot ID into the blacklist warning during your
  // own matches.
  const isOwnAccount = useMemo(
    () => !!result && accounts.some(a => a.id === result.puuid),
    [result, accounts],
  )

  const trimmed = riotIdInput.trim()
  const canSubmit = trimmed.includes('#') && !loading

  const handleLookup = useCallback(async () => {
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await window.electronAPI.lookupPlayer({ riotId: trimmed })
      if (r.success) setResult(r)
      else setError(r.error || 'Lookup failed.')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [trimmed, canSubmit])

  const totalMatches = useMemo(() => {
    if (!result?.history) return 0
    const named = result.history.reduce((a, h) => a + (h.knownCount || 0) + (h.inferredCount || 0), 0)
    return named + (result.unattributedCount || 0)
  }, [result])

  const handleBlacklist = useCallback(async () => {
    if (!result) return
    try {
      const r = await window.electronAPI.addToBlacklist({
        puuid: result.puuid,
        name: `${result.name}#${result.tag}`,
        reason: '',
      })
      if (r.success) {
        toast.success(`${result.name}#${result.tag} blacklisted`)
        setResult(prev => prev ? { ...prev, blacklisted: true } : prev)
      } else {
        toast.error(r.error || 'Failed to blacklist.')
      }
    } catch (e) {
      toast.error(e.message)
    }
  }, [result, toast])

  const handleUnblacklist = useCallback(async () => {
    if (!result) return
    try {
      await window.electronAPI.removeFromBlacklist(result.puuid)
      toast.success('Removed from blacklist')
      setResult(prev => prev ? { ...prev, blacklisted: false } : prev)
    } catch (e) {
      toast.error(e.message)
    }
  }, [result, toast])

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={riotIdInput}
            onChange={(e) => setRiotIdInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLookup() }}
            placeholder="Riot ID (e.g. v1ni#cius)"
            disabled={loading}
            className="w-full h-9 pl-9 pr-3 rounded-md border bg-secondary/30 text-sm focus:outline-none focus:border-purple-500/50 transition-colors disabled:opacity-60"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        <Button onClick={handleLookup} disabled={!canSubmit} className="gap-1.5">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          {loading ? 'Looking up...' : 'Lookup'}
        </Button>
      </div>

      {loading && <LookupSkeleton />}

      {error && !loading && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-500">Lookup failed</p>
            <p className="text-[11px] text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {result && !loading && (
        <div className="flex flex-col gap-4">
          {/* Header card with current name + region + blacklist toggle */}
          <div className="rounded-md border bg-card p-3 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-purple-500/15 border border-purple-500/40 flex items-center justify-center shrink-0">
              <UserCircle className="h-6 w-6 text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{result.name}#{result.tag}</p>
              <p className="text-[11px] text-muted-foreground">
                Region: {result.region?.toUpperCase() || '?'}
                {isOwnAccount && (
                  <span className="ml-2 text-purple-400">· Your account</span>
                )}
                {!isOwnAccount && result.blacklisted && (
                  <span className="ml-2 text-red-400">· Blacklisted</span>
                )}
              </p>
            </div>
            {isOwnAccount ? null : result.blacklisted ? (
              <Button variant="outline" onClick={handleUnblacklist} className="gap-1.5 h-8" title="Remove from blacklist">
                <ShieldCheck className="h-3.5 w-3.5" />
                Unblacklist
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={handleBlacklist}
                className="gap-1.5 h-8 border-red-500/30 text-red-500 hover:bg-red-500/10"
                title="Add to blacklist"
              >
                <Ban className="h-3.5 w-3.5" />
                Blacklist
              </Button>
            )}
          </div>

          {/* Name timeline */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 text-purple-400" />
              <h3 className="text-sm font-semibold">Name Timeline</h3>
              <span className="text-xs text-muted-foreground">
                ({result.history?.length || 0} period{(result.history?.length || 0) === 1 ? '' : 's'})
              </span>
            </div>

            {(!result.history || result.history.length === 0) && (
              <div className="rounded-md border border-dashed bg-secondary/20 p-4 text-center space-y-1">
                <p className="text-xs text-muted-foreground">
                  No name data found in Henrikdev's cache for this player.
                </p>
              </div>
            )}

            {result.history?.length > 0 && (
              <div className="space-y-1.5">
                {result.history.map(h => (
                  <NameRow key={`${h.name}#${h.tag}`} entry={h} />
                ))}
              </div>
            )}

            {totalMatches > 0 && (
              <p className="text-[10px] text-muted-foreground/70 italic px-1">
                Built from {totalMatches} cached match{totalMatches === 1 ? '' : 'es'} in Henrikdev's stored cache. Older names might not show.
              </p>
            )}
          </section>
        </div>
      )}

      {!result && !loading && !error && (
        <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2 px-6 text-center">
          <Search className="h-8 w-8 opacity-40" />
          <p>Look up any Valorant player by Riot ID.</p>
          <p className="text-xs max-w-sm">
            Surfaces every distinct Riot ID the player has been seen as in
            Henrikdev's cached match history, with the observation date range
            for each.
          </p>
          <p className="text-[10px] text-muted-foreground/70 mt-2 inline-flex items-center gap-1">
            Requires a free Henrikdev API key in Settings <ExternalLink className="h-2.5 w-2.5" />
          </p>
        </div>
      )}
    </div>
  )
}

function NameRow({ entry }) {
  const total = (entry.knownCount || 0) + (entry.inferredCount || 0)
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border px-2.5 py-2 ${
        entry.isCurrent
          ? 'border-purple-500/40 bg-purple-500/5'
          : 'border-border bg-card/50'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{entry.name}#{entry.tag}</p>
          {entry.isCurrent && (
            <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/30 leading-none">
              Current
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {formatRange(entry.knownFirstSeen, entry.knownLastSeen, entry.isCurrent)}
          {' · '}
          {total} match{total === 1 ? '' : 'es'}
        </p>
      </div>
    </div>
  )
}

function LookupSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-card p-3 flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full shrink-0" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2.5 w-24" />
        </div>
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <div className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-44" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
