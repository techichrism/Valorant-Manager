import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Swords, RefreshCw, Shield, Crosshair, EyeOff, Circle, CircleCheck, Copy, AlertTriangle, Ban, Sparkles } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { PlayerStatsDialog } from '@/components/PlayerStatsDialog'
import { BlacklistDialog } from '@/components/BlacklistDialog'

// Shimmer placeholder that mirrors the real match-info layout: map card,
// self banner, then a column of player rows.
function MatchInfoSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-card p-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 w-16 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>
      </div>
      <div className="rounded-md border bg-card p-3 flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded shrink-0" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2.5 w-24" />
        </div>
        <Skeleton className="h-10 w-10 shrink-0" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <div className="space-y-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
              <Skeleton className="h-8 w-8 rounded shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2.5 w-16" />
              </div>
              <Skeleton className="h-7 w-7 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Pure puuid-based lookup. Blacklist entries are always puuid-keyed now
// (added via the stats dialog), so a direct map access is all we need.
function findBlacklistEntry(blacklist, player) {
  if (!player?.puuid) return null
  return blacklist[player.puuid] || null
}

// Thick colored left borders used to visually group players in the same
// party. Strings are statically listed so Tailwind's JIT picks them up.
// We only colorize parties of 2+ visible players — solos don't need it.
const PARTY_PALETTE = [
  'border-l-4 border-l-fuchsia-500',
  'border-l-4 border-l-cyan-400',
  'border-l-4 border-l-amber-400',
  'border-l-4 border-l-rose-400',
  'border-l-4 border-l-teal-400',
]

function buildPartyColors(players) {
  const counts = new Map()
  const order = []
  for (const p of players) {
    if (!p?.partyId) continue
    if (!counts.has(p.partyId)) { counts.set(p.partyId, 0); order.push(p.partyId) }
    counts.set(p.partyId, counts.get(p.partyId) + 1)
  }
  const colors = {}
  let i = 0
  for (const pid of order) {
    if (counts.get(pid) >= 2) {
      colors[pid] = PARTY_PALETTE[i % PARTY_PALETTE.length]
      i++
    }
  }
  return colors
}

// User's own player card banner. Clickable — opens the same stats dialog
// you'd see for any other player. No background splash art (user request).
function SelfBanner({ self, onClick, partyColors }) {
  const partyClass = self.partyId ? partyColors?.[self.partyId] : null
  return (
    <button
      type="button"
      onClick={onClick}
      title={partyClass ? 'In your party' : undefined}
      className={`w-full flex items-center gap-3 rounded-md border bg-card/60 p-3 text-left transition-colors duration-150 hover:border-purple-500/30 hover:bg-card ${partyClass || ''}`}
    >
      {self.agent?.icon ? (
        <img src={self.agent.icon} alt={self.agent.name} className="h-12 w-12 rounded shrink-0 border border-border" />
      ) : (
        <div className="h-12 w-12 rounded bg-secondary flex items-center justify-center shrink-0">
          <Circle className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{self.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {self.agent?.name || 'Picking...'}
          {self.accountLevel ? ` · Lv ${self.accountLevel}` : ''}
        </p>
      </div>
      {self.rank?.icon && (
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <p className="text-xs font-medium truncate">{self.rank.name}</p>
            {self.rank.rr != null && <p className="text-[10px] font-semibold text-purple-400">{self.rank.rr} RR</p>}
          </div>
          <img src={self.rank.icon} alt={self.rank.name} className="h-10 w-10" />
        </div>
      )}
    </button>
  )
}

function PlayerRow({ p, blacklisted, onClick, onCopy, partyColors }) {
  const handleCopy = (e) => {
    e.stopPropagation()
    onCopy(p.name)
  }
  const partyClass = p.partyId ? partyColors?.[p.partyId] : null
  const base = 'group w-full flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-150'
  const skin = blacklisted
    ? 'border-red-500/50 bg-red-500/10 hover:bg-red-500/15'
    : 'bg-card/50 hover:border-purple-500/30 hover:bg-card'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${skin} ${partyClass || ''}`}
      title={blacklisted ? `Blacklisted: ${blacklisted.reason || 'No reason'}` : (partyClass ? 'In your party' : undefined)}
    >
      <div className="flex items-center gap-2.5 w-full">
      {p.agent?.icon ? (
        <img src={p.agent.icon} alt={p.agent.name} className="h-8 w-8 rounded shrink-0" />
      ) : (
        <div className="h-8 w-8 rounded bg-secondary flex items-center justify-center shrink-0">
          <Circle className="h-3 w-3 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate" title={p.name}>{p.name}</p>
          {p.isIncognito && <EyeOff className="h-3 w-3 text-muted-foreground shrink-0" title="Incognito" />}
          {p.locked && <CircleCheck className="h-3 w-3 text-green-500 shrink-0" title="Locked in" />}
          {p.isSmurf && (
            <span
              className="inline-flex items-center gap-0.5 shrink-0 px-1 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-[9px] font-bold text-amber-400 uppercase tracking-wider leading-none"
              title={`Possible smurf — Lv ${p.accountLevel} at ${p.rank?.name || 'high rank'}. Open Player Stats for K/D-confirmed detection.`}
            >
              <Sparkles className="h-2.5 w-2.5" />
              SMURF
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {p.agent?.name || 'Picking...'}{p.accountLevel ? ` · Lv ${p.accountLevel}` : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        title="Copy name"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      {p.rank?.icon && (
        <div className="flex flex-col items-center shrink-0 gap-0.5">
          <img src={p.rank.icon} alt={p.rank.name} className="h-7 w-7" />
          {p.rank.rr != null && (
            <span className="text-[9px] font-semibold text-purple-400 leading-none">{p.rank.rr} RR</span>
          )}
        </div>
      )}
      </div>
    </button>
  )
}

function TeamPanel({ title, players, accent, icon: Icon, blacklist, onPlayerClick, onCopy, partyColors }) {
  return (
    <div className="flex-1 min-w-0 space-y-2">
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${accent}`} />
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">({players.length})</span>
      </div>
      <div className="space-y-1.5">
        {players.length
          ? players.map(p => (
              <PlayerRow
                key={p.puuid}
                p={p}
                blacklisted={findBlacklistEntry(blacklist, p)}
                onClick={() => onPlayerClick(p)}
                onCopy={onCopy}
                partyColors={partyColors}
              />
            ))
          : <p className="text-xs text-muted-foreground px-1">No players visible yet.</p>}
      </div>
    </div>
  )
}


export function MatchInfoTab({ accounts, autoRefresh, statuses = {} }) {
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [match, setMatch] = useState(null)
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [blacklist, setBlacklist] = useState({})
  const [blacklistOpen, setBlacklistOpen] = useState(false)
  const toast = useToast()

  // Pre-select the running account if available, otherwise fall back to
  // first. Also recovers from a removed-account stale-selection: if the
  // previously-picked id no longer exists, snap to the running account or
  // first available so fetches don't 404.
  useEffect(() => {
    if (!accounts.length) {
      if (selectedId) setSelectedId('')
      return
    }
    if (!accounts.some(a => a.id === selectedId)) {
      const running = accounts.find(a => statuses[a.id]?.status === 'running')
      setSelectedId(running ? running.id : accounts[0].id)
    }
  }, [accounts, selectedId, statuses])

  // Load blacklist once on mount; refresh when a player is (un)blacklisted
  // via the stats dialog by passing the setter down.
  const reloadBlacklist = useCallback(async () => {
    try {
      const result = await window.electronAPI.getBlacklist()
      if (result.success) setBlacklist(result.blacklist || {})
    } catch { /* silent */ }
  }, [])
  useEffect(() => { reloadBlacklist() }, [reloadBlacklist])

  const AUTO_REFRESH_MS = 15_000
  const fetchInProgress = useRef(false)

  const fetchMatch = useCallback(async (silent = false) => {
    if (!selectedId) return
    if (fetchInProgress.current) return // prevent overlapping fetches
    fetchInProgress.current = true
    if (!silent) setLoading(true)
    try {
      const result = await window.electronAPI.getMatchInfo(selectedId)
      if (result.success) setMatch(result.match)
      else if (!silent) { toast.error(result.error || 'Failed to load match info.'); setMatch(null) }
    } catch (e) {
      if (!silent) toast.error(e.message)
    } finally {
      fetchInProgress.current = false
      if (!silent) setLoading(false)
    }
  }, [selectedId, toast])

  useEffect(() => {
    if (selectedId) fetchMatch()
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh interval — runs silently (no loading spinner, no error
  // toasts) so the UI stays calm during background refreshes. Keeps
  // polling through INGAME too: an earlier version paused during a
  // match to "save network noise", but that trapped the state — the
  // transition out of INGAME (you left, the match ended, the client
  // closed) is itself only detectable via a refresh, so without polling
  // the user was stuck on the in-game snapshot until they hit refresh
  // manually. Cost during gameplay is small: rank + token caches absorb
  // most of it, and the only on-the-wire calls are coregame.* + a name-
  // service batch.
  useEffect(() => {
    if (!autoRefresh || !selectedId) return
    const id = setInterval(() => fetchMatch(true), AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [autoRefresh, selectedId, fetchMatch])

  // Match-end detection. Watches `match` for two transitions and fires a
  // single toast on either:
  //   1. INGAME → not-in-match (you left / match ended / client closed)
  //   2. INGAME → PREGAME      (queued straight into agent select again)
  // Account-tab auto-refresh already handles RR/W-L updates via its
  // own RR-delta detector, so this exists purely as a "you're done"
  // notification for users who left Match Info open.
  //
  // Edge cases this guards against:
  //   - Errors during INGAME (silent fetch fails) keep `match` unchanged,
  //     so prev stays INGAME and no false toast fires.
  //   - Manual-refresh errors set `match` to null. We require `match` to
  //     be truthy before firing, so null isn't mistaken for a transition.
  //   - Account switches reset prev to null below, so the next match's
  //     state replaces it cleanly without firing a toast.
  const prevPhaseRef = useRef(null)
  useEffect(() => { prevPhaseRef.current = null }, [selectedId])
  useEffect(() => {
    const prev = prevPhaseRef.current
    if (prev === 'INGAME' && match) {
      if (!match.inMatch) {
        toast.success('Match ended', { duration: 6000 })
      } else if (match.phase === 'PREGAME') {
        toast.success('Match ended — back in agent select', { duration: 6000 })
      }
    }
    if (match) prevPhaseRef.current = match.inMatch ? match.phase : null
  }, [match, toast])

  // Pre-compute the blacklist-hit set for the current match — used by the
  // warning banner, the row highlighter, and the toast below. Includes the
  // self player so you see a hit even if it's on your own card.
  const blacklistHits = useMemo(() => {
    if (!match?.inMatch) return []
    const all = [match.self, ...(match.ally || []), ...(match.enemy || [])].filter(Boolean)
    return all.map(p => ({ p, entry: findBlacklistEntry(blacklist, p) })).filter(x => x.entry)
  }, [match, blacklist])

  // Party grouping — only highlight parties of 2+ visible players. The
  // local Riot Client chat roster only ever delivers presences for self
  // + online friends; stranger parties never become visible (Riot-side
  // limitation, same ceiling every community tracker hits). In practice
  // any colored party here contains the user, hence the "In your party"
  // tooltip on PlayerRow.
  const partyColors = useMemo(() => {
    if (!match?.inMatch) return {}
    const all = [match.self, ...(match.ally || []), ...(match.enemy || [])].filter(Boolean)
    return buildPartyColors(all)
  }, [match])

  // Warn when blacklisted players are in the current match. Dedupes by
  // (matchId + sorted puuid set) so we don't re-fire on every 15s auto-
  // refresh tick or on unrelated blacklist updates. Only re-warns when
  // the set of hits actually changes (new match, or someone added/removed
  // mid-match via the Blacklist dialog).
  const lastWarnedKeyRef = useRef('')
  useEffect(() => {
    if (!blacklistHits.length) {
      lastWarnedKeyRef.current = ''
      return
    }
    const key = `${match?.matchId || ''}:${blacklistHits.map(x => x.p.puuid).sort().join(',')}`
    if (key === lastWarnedKeyRef.current) return
    lastWarnedKeyRef.current = key
    const names = blacklistHits.map(x => x.entry.name || x.p.name).join(', ')
    toast.error(`⚠  Blacklisted player in match: ${names}`, { duration: 15000 })
  }, [blacklistHits, match, toast])

  const handleCopyName = useCallback(async (name) => {
    try {
      await navigator.clipboard.writeText(name)
      toast.success(`Copied ${name}`)
    } catch {
      toast.error('Could not copy to clipboard.')
    }
  }, [toast])

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      <div className="flex items-center gap-2">
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select an account..." />
          </SelectTrigger>
          <SelectContent>
            {accounts.map(a => (
              <SelectItem key={a.id} value={a.id}>
                {a.displayName || a.username}{a.nickname ? ` (${a.nickname})` : ''} · {a.region}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={() => setBlacklistOpen(true)} title="Manage blacklist">
          <Ban className="h-4 w-4" />
        </Button>
        <div className="relative">
          <Button
            variant="outline"
            size="icon"
            onClick={() => fetchMatch(false)}
            disabled={loading || !selectedId}
            title={autoRefresh ? 'Refresh now (auto-refresh active every 15s)' : 'Refresh'}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {autoRefresh && !loading && (
            <span
              className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse-soft pointer-events-none"
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      {blacklistHits.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-500">Blacklisted player{blacklistHits.length > 1 ? 's' : ''} in this match</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {blacklistHits.map(x => x.entry.name || x.p.name).join(', ')}
            </p>
          </div>
        </div>
      )}

      {loading && !match && <MatchInfoSkeleton />}

      {match && !match.inMatch && (
        <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
          <Swords className="h-8 w-8 opacity-40" />
          <p>Not currently in a match.</p>
          <p className="text-xs">Queue up or enter agent select, then hit refresh.</p>
        </div>
      )}

      {match?.inMatch && (
        <div className="flex flex-col gap-4">
          <div className="rounded-md border bg-card p-3 space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {match.map?.splash && (
                  <div className="h-10 w-16 rounded overflow-hidden shrink-0 bg-secondary">
                    <img src={match.map.splash} alt={match.map.name} className="h-full w-full object-cover" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{match.map?.name || 'Unknown Map'}</p>
                  <p className="text-xs text-muted-foreground">
                    {match.phase === 'PREGAME' ? 'Agent Select' : 'In Game'}
                  </p>
                </div>
              </div>
              {!match.isFreeForAll && (
                <div className={`px-2 py-1 rounded text-xs font-semibold ${
                  match.yourSide === 'Attack'
                    ? 'bg-red-500/15 text-red-500'
                    : 'bg-blue-500/15 text-blue-500'
                }`}>
                  {match.yourSide}
                </div>
              )}
            </div>
          </div>

          {/* Self card — clickable to open the stats dialog for yourself. */}
          {match.self && (
            <SelfBanner
              self={match.self}
              onClick={() => setSelectedPlayer(match.self)}
              partyColors={partyColors}
            />
          )}

          {match.isFreeForAll ? (
            // Deathmatch / other FFA modes: everyone except the viewing
            // player ends up in `enemy` because each player has a unique
            // TeamID. Render as a single "Players" panel.
            <TeamPanel
              title="Players"
              players={match.enemy}
              accent="text-muted-foreground"
              icon={Swords}
              blacklist={blacklist}
              onPlayerClick={setSelectedPlayer}
              onCopy={handleCopyName}
              partyColors={partyColors}
            />
          ) : (
            <>
              <TeamPanel
                title="Your Team"
                players={match.ally}
                accent="text-green-500"
                icon={Shield}
                blacklist={blacklist}
                onPlayerClick={setSelectedPlayer}
                onCopy={handleCopyName}
                partyColors={partyColors}
              />
              {match.phase === 'INGAME' && (
                <TeamPanel
                  title="Enemy Team"
                  players={match.enemy}
                  accent="text-red-500"
                  icon={Crosshair}
                  blacklist={blacklist}
                  onPlayerClick={setSelectedPlayer}
                  onCopy={handleCopyName}
                  partyColors={partyColors}
                />
              )}
            </>
          )}
          {match.phase === 'PREGAME' && (
            <p className="text-xs text-muted-foreground italic">
              Enemy team is hidden until the match starts.
            </p>
          )}
        </div>
      )}

      <PlayerStatsDialog
        open={!!selectedPlayer}
        onOpenChange={(o) => { if (!o) setSelectedPlayer(null) }}
        player={selectedPlayer}
        viewerAccountId={selectedId}
        accounts={accounts}
        blacklistEntry={selectedPlayer ? findBlacklistEntry(blacklist, selectedPlayer) : null}
        onBlacklistChange={reloadBlacklist}
      />

      <BlacklistDialog
        open={blacklistOpen}
        onOpenChange={setBlacklistOpen}
        onChange={reloadBlacklist}
      />
    </div>
  )
}
