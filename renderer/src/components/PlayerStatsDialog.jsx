import { useState, useEffect, useMemo } from 'react'
import { User, Trophy, TrendingUp, Swords, Ban, CheckCircle2, History, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'

// Placeholder that mirrors the stats dialog layout so the dialog feels full
// immediately instead of a blank spinner. Mirrors: 2 rank cards → blacklist
// button → separator → agents chips placeholder → stats grid → match rows.
function PlayerStatsSkeleton() {
  return (
    <div className="space-y-4 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-[76px] rounded-md" />
        <Skeleton className="h-[76px] rounded-md" />
      </div>
      <Skeleton className="h-[88px] rounded-md" />
      <Skeleton className="h-8 rounded-md" />
      <Separator />
      <Skeleton className="h-3 w-32" />
      <Skeleton className="h-[104px] rounded-md" />
      <div className="space-y-1.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
            <Skeleton className="h-8 w-8 rounded shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-36" />
            </div>
            <Skeleton className="h-4 w-4 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function PlayerStatsDialog({ open, onOpenChange, player, viewerAccountId, accounts = [], blacklistEntry, onBlacklistChange }) {
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState(null)
  const [showReasonInput, setShowReasonInput] = useState(false)
  const [reasonText, setReasonText] = useState('')
  const [agentFilter, setAgentFilter] = useState(null) // agent uuid or null for "all"
  const toast = useToast()

  // Hide blacklist controls when the player is ANY of the user's saved
  // accounts (not just the one currently authed for the viewer call).
  // Without this, viewing yourself in match info via a different account
  // would let you blacklist your own puuid.
  const isOwnAccount = !!player?.puuid && (
    player.puuid === viewerAccountId || accounts.some(a => a.id === player.puuid)
  )

  useEffect(() => {
    if (!open) {
      setShowReasonInput(false)
      setReasonText('')
      setAgentFilter(null)
      return
    }
    if (!player?.puuid || !viewerAccountId) return
    let cancelled = false
    setStats(null)
    setLoading(true)
    window.electronAPI.getPlayerStats(viewerAccountId, player.puuid)
      .then((result) => {
        if (cancelled) return
        if (result.success) setStats(result.stats)
        else toast.error(result.error || 'Failed to load stats.')
      })
      .catch((e) => { if (!cancelled) toast.error(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, player?.puuid, viewerAccountId, toast])

  // Filtered match list: drops anything not matching the agent filter.
  const filteredMatches = useMemo(() => {
    const list = stats?.matches ?? []
    if (!agentFilter) return list
    return list.filter(m => m.agent?.uuid === agentFilter)
  }, [stats, agentFilter])

  // Aggregate computed client-side over the filtered list. When the filter
  // is inactive this matches what the backend returned, but we always
  // recompute so the agent filter changes the numbers live.
  const aggregate = useMemo(() => {
    const list = filteredMatches
    let wins = 0, losses = 0, k = 0, d = 0, a = 0
    let acsTotal = 0, acsMatches = 0
    let hsTotal = 0, hsMatches = 0
    let adrTotal = 0, adrMatches = 0
    let ddTotal = 0, ddMatches = 0
    for (const m of list) {
      if (m.won) wins++; else losses++
      k += m.kills; d += m.deaths; a += m.assists
      if (m.acs) { acsTotal += m.acs; acsMatches++ }
      if (m.hsPercent) { hsTotal += m.hsPercent; hsMatches++ }
      if (m.adr) { adrTotal += m.adr; adrMatches++ }
      if (m.ddDelta) { ddTotal += m.ddDelta; ddMatches++ }
    }
    const kd = d > 0 ? Math.round((k / d) * 100) / 100 : k
    const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0
    return {
      wins, losses, kills: k, deaths: d, assists: a, kd, winRate,
      acs: acsMatches > 0 ? Math.round(acsTotal / acsMatches) : 0,
      hsPercent: hsMatches > 0 ? Math.round(hsTotal / hsMatches) : 0,
      adr: adrMatches > 0 ? Math.round(adrTotal / adrMatches) : 0,
      ddDelta: ddMatches > 0 ? Math.round(ddTotal / ddMatches) : 0,
    }
  }, [filteredMatches])

  // Unique agents played + per-agent match counts. Computed once per stats
  // change instead of inside the chip render loop (which used to re-filter
  // the entire match list per chip on every render — O(agents × matches)).
  const { agentsPlayed, agentCounts } = useMemo(() => {
    const seen = new Map()
    const counts = {}
    for (const m of stats?.matches ?? []) {
      const uuid = m.agent?.uuid
      if (!uuid) continue
      if (!seen.has(uuid)) {
        seen.set(uuid, { uuid, name: m.agent.name, icon: m.agent.icon })
      }
      counts[uuid] = (counts[uuid] || 0) + 1
    }
    return { agentsPlayed: Array.from(seen.values()), agentCounts: counts }
  }, [stats])

  // Smurf detection — graded confidence using level + peak rank tier + K/D
  // over the recent competitive matches we just loaded. Uses the PEAK tier
  // because a smurf's CURRENT rank is often deflated mid-climb. K/D is the
  // tiebreaker that distinguishes "old account climbing back" from "actual
  // smurf carrying every game". Without K/D, the inline match-info badge
  // is a level+rank-only heuristic; this dialog refines it.
  //   - LIKELY:   level < 30 + peak >= Diamond 1 + K/D >= 1.5
  //   - POSSIBLE: level < 40 + peak >= Diamond 1 + K/D >= 1.2
  //   - none:     fails any of the three
  const smurfState = useMemo(() => {
    const level = player?.accountLevel || 0
    const peakTier = stats?.peak?.tier || 0
    const kd = stats?.recent?.kd ?? aggregate?.kd ?? 0
    if (level <= 0 || peakTier < 17) return null // need level + diamond+ peak
    if (level < 30 && kd >= 1.5) {
      return { confidence: 'likely', level, kd, peakName: stats.peak.name }
    }
    if (level < 40 && kd >= 1.2) {
      return { confidence: 'possible', level, kd, peakName: stats.peak.name }
    }
    return null
  }, [player, stats, aggregate])

  const handleConfirmBlacklist = async () => {
    try {
      await window.electronAPI.addToBlacklist({
        puuid: player.puuid,
        name: player.name,
        reason: reasonText.trim(),
      })
      toast.success(`${player.name} added to blacklist`)
      setShowReasonInput(false)
      setReasonText('')
      onBlacklistChange && onBlacklistChange()
    } catch (e) { toast.error(e.message) }
  }

  const handleRemoveBlacklist = async () => {
    try {
      await window.electronAPI.removeFromBlacklist(player.puuid)
      toast.success(`Removed ${player.name} from blacklist`)
      onBlacklistChange && onBlacklistChange()
    } catch (e) { toast.error(e.message) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-4 w-4" />
            <span className="truncate">{player?.name || 'Player'}</span>
          </DialogTitle>
          <DialogDescription>
            Competitive rank and recent match history
          </DialogDescription>
        </DialogHeader>

        {loading && <PlayerStatsSkeleton />}

        {stats && !loading && (
          <div className="space-y-4 pt-1">
            {/* Rank cards: larger, with icons, act name. Current shows RR;
                Peak hides it because Riot only exposes ending RR per season,
                not in-act peak RR — surfacing the ending value misled users
                into thinking it was their actual peak. */}
            <div className="grid grid-cols-2 gap-2">
              <RankCard label="Current" icon={Trophy} rank={stats.current} showAct showRR />
              <RankCard label="Peak"    icon={TrendingUp} rank={stats.peak} />
            </div>

            {/* Last 3 acts — shows the rank this player ENDED each of the
                previous acts in. Better signal than peak alone for judging
                consistency (tracker.gg-style). */}
            {stats.actHistory?.length > 0 && (
              <div className="rounded-md border bg-card p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <History className="h-3 w-3 text-purple-400 shrink-0" />
                  <p className="text-[10px] text-purple-400 uppercase tracking-wider font-semibold">Last {stats.actHistory.length} Acts</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {stats.actHistory.map((act) => (
                    <ActHistoryCell key={act.seasonId} act={act} />
                  ))}
                </div>
              </div>
            )}

            {/* Smurf banner — only shown when level + rank + K/D triple
                heuristic fires. "Likely" is red, "possible" is amber. */}
            {smurfState && (
              <div className={`rounded-md border p-3 flex items-center gap-2.5 ${
                smurfState.confidence === 'likely'
                  ? 'border-red-500/50 bg-red-500/10'
                  : 'border-amber-500/40 bg-amber-500/10'
              }`}>
                <Sparkles className={`h-4 w-4 shrink-0 ${smurfState.confidence === 'likely' ? 'text-red-400' : 'text-amber-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-semibold ${smurfState.confidence === 'likely' ? 'text-red-400' : 'text-amber-400'}`}>
                    {smurfState.confidence === 'likely' ? 'Likely smurf' : 'Possible smurf'}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Lv {smurfState.level} · peak {smurfState.peakName} · K/D {smurfState.kd}
                  </p>
                </div>
              </div>
            )}

            {/* Blacklist control — hidden when the target is one of your
                own accounts (any of them, not just the viewing one). */}
            {isOwnAccount ? null : blacklistEntry ? (
              <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Ban className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  <p className="text-sm font-semibold text-red-500">Blacklisted</p>
                </div>
                {blacklistEntry.reason && (
                  <p className="text-xs text-muted-foreground pl-5 italic">"{blacklistEntry.reason}"</p>
                )}
                <Button variant="outline" onClick={handleRemoveBlacklist} className="w-full gap-1.5 h-8">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Remove from blacklist
                </Button>
              </div>
            ) : !showReasonInput ? (
              <Button
                variant="outline"
                onClick={() => setShowReasonInput(true)}
                className="w-full gap-1.5 h-8 border-red-500/30 text-red-500 hover:bg-red-500/10"
              >
                <Ban className="h-3.5 w-3.5" />
                Add to blacklist
              </Button>
            ) : (
              <div className="rounded-md border bg-secondary/30 p-3 space-y-2">
                <label className="text-xs font-medium">Reason (optional)</label>
                <input
                  type="text"
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmBlacklist() }}
                  placeholder="e.g. griefer, toxic"
                  autoFocus
                  className="w-full h-8 px-2.5 rounded-md border bg-background text-xs focus:outline-none focus:border-purple-500/50 transition-colors"
                />
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => { setShowReasonInput(false); setReasonText('') }} className="flex-1 h-8">
                    Cancel
                  </Button>
                  <Button onClick={handleConfirmBlacklist} className="flex-1 h-8 gap-1.5 bg-red-500 hover:bg-red-600 text-white">
                    <Ban className="h-3.5 w-3.5" />
                    Blacklist
                  </Button>
                </div>
              </div>
            )}

            <Separator />

            {/* Match history header */}
            <div className="flex items-center gap-1.5">
              <Swords className="h-3.5 w-3.5 text-purple-400" />
              <h3 className="text-sm font-semibold text-foreground">Recent Competitive</h3>
              <span className="text-xs text-muted-foreground">({stats.matches.length})</span>
            </div>

            {/* Aggregate stats over the filtered competitive matches */}
            <div className="rounded-md border bg-card p-3 space-y-3">
              <div className="grid grid-cols-4 gap-3 text-center">
                <StatCell
                  top={<><span className="text-green-500">{aggregate.wins}W</span> <span className="text-red-500">{aggregate.losses}L</span></>}
                  bot="record"
                />
                <StatCell
                  top={<span className={aggregate.winRate >= 50 ? 'text-green-500' : 'text-red-500'}>{aggregate.winRate}%</span>}
                  bot="win rate"
                />
                <StatCell
                  top={<span className={aggregate.kd >= 1 ? 'text-green-500' : 'text-red-500'}>{aggregate.kd}</span>}
                  bot="K/D"
                />
                <StatCell top={`${aggregate.kills}/${aggregate.deaths}/${aggregate.assists}`} bot="KDA" />
              </div>
              <div className="border-t pt-2 grid grid-cols-4 gap-3 text-center">
                <StatCell top={<span className="text-cyan-400">{aggregate.acs || 0}</span>} bot="ACS" />
                <StatCell top={<span className="text-cyan-400">{aggregate.adr || 0}</span>} bot="ADR" />
                <StatCell top={<span className="text-amber-400">{aggregate.hsPercent || 0}%</span>} bot="HS%" />
                <StatCell
                  top={<span className={aggregate.ddDelta > 0 ? 'text-green-500' : aggregate.ddDelta < 0 ? 'text-red-500' : ''}>{aggregate.ddDelta > 0 ? `+${aggregate.ddDelta}` : (aggregate.ddDelta || 0)}</span>}
                  bot="DDΔ"
                />
              </div>
            </div>

            {/* Agent filter chips — only rendered when the player has played
                multiple agents in the fetched history. */}
            {agentsPlayed.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAgentFilter(null)}
                  className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                    !agentFilter
                      ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                      : 'border-border text-muted-foreground hover:bg-secondary/60'
                  }`}
                >
                  All ({stats.matches.length})
                </button>
                {agentsPlayed.map(ag => {
                  const count = agentCounts[ag.uuid] || 0
                  const active = agentFilter === ag.uuid
                  return (
                    <button
                      key={ag.uuid}
                      type="button"
                      onClick={() => setAgentFilter(active ? null : ag.uuid)}
                      className={`text-[11px] px-2 py-1 rounded-full border flex items-center gap-1.5 transition-colors ${
                        active
                          ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                          : 'border-border text-muted-foreground hover:bg-secondary/60'
                      }`}
                    >
                      {ag.icon && <img src={ag.icon} alt={ag.name} className="h-3.5 w-3.5 rounded" />}
                      <span>{ag.name} ({count})</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Match list (filtered) */}
            {filteredMatches.length > 0 ? (
              <div className="space-y-1.5">
                {filteredMatches.map((m) => (
                  <MatchRow key={m.matchId} m={m} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-4">
                {agentFilter ? 'No matches on this agent.' : 'No recent competitive matches.'}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RankCard({ label, icon: Icon, rank, showAct = false, showRR = false }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="h-3 w-3 text-purple-400 shrink-0" />
        <p className="text-[10px] text-purple-400 uppercase tracking-wider font-semibold">{label}</p>
      </div>
      {rank ? (
        <div className="flex items-start gap-2">
          {rank.icon && <img src={rank.icon} alt={rank.name} className="h-10 w-10 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold truncate leading-tight text-foreground">{rank.name}</p>
            {showRR && rank.rr != null && (
              <span className="inline-block text-[10px] font-semibold text-purple-400 bg-purple-500/10 border border-purple-500/30 rounded px-1.5 py-0.5 leading-none mt-1">
                {rank.rr} RR
              </span>
            )}
            {showAct && rank.act && (
              <p className="text-[10px] text-muted-foreground/80 truncate mt-1">
                {rank.act}{rank.games > 0 && ` · ${rank.games} games`}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Unranked</p>
      )}
    </div>
  )
}

function ActHistoryCell({ act }) {
  // Show the rank icon + ending rank name + RR + act label + games. Stacked
  // compact so three fit per row. Color hierarchy:
  //   - rank name: foreground, bold
  //   - RR pill:   purple accent for emphasis
  //   - act label: muted
  //   - games:     muted, smaller
  return (
    <div className="rounded-md border bg-card/60 p-2 flex flex-col items-center text-center gap-1">
      {act.icon ? (
        <img src={act.icon} alt={act.name} className="h-10 w-10" />
      ) : (
        <div className="h-10 w-10 flex items-center justify-center">
          <span className="text-[10px] text-muted-foreground">—</span>
        </div>
      )}
      <p className="text-[11px] font-semibold leading-tight truncate max-w-full text-foreground">
        {act.name}
      </p>
      {act.rr != null && (
        <span className="text-[10px] font-semibold text-purple-400 bg-purple-500/10 border border-purple-500/30 rounded px-1.5 py-0.5 leading-none">
          {act.rr} RR
        </span>
      )}
      <p className="text-[10px] text-muted-foreground leading-tight truncate max-w-full">
        {act.act}
      </p>
      <p className="text-[9px] text-muted-foreground/70 leading-tight">
        {act.games} games
      </p>
    </div>
  )
}

function StatCell({ top, bot }) {
  return (
    <div>
      <p className="text-base font-bold leading-tight">{top}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-0.5">{bot}</p>
    </div>
  )
}

function MatchRow({ m }) {
  // Color hierarchy:
  //   - map name:    foreground (white)
  //   - agent name:  muted
  //   - score:       foreground (the round count is the headline secondary stat)
  //   - K/D/A:       kills green, deaths red, assists muted
  //   - ACS/ADR:     cyan (offensive metrics)
  //   - HS%:         amber (precision metric)
  //   - W/L badge:   large colored letter
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border px-2.5 py-2 ${
        m.won ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
      }`}
    >
      {m.agent?.icon && <img src={m.agent.icon} alt={m.agent.name} className="h-8 w-8 rounded shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-semibold truncate text-foreground">{m.map}</p>
          <span className="text-[10px] text-muted-foreground/60">·</span>
          <p className="text-[11px] text-muted-foreground truncate">{m.agent?.name || 'Unknown'}</p>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-[11px] font-semibold text-foreground">{m.score}</span>
          <span className="text-[10px] text-muted-foreground/60">·</span>
          <span className="text-[11px] font-medium">
            <span className="text-green-500">{m.kills}</span>
            <span className="text-muted-foreground/60">/</span>
            <span className="text-red-500">{m.deaths}</span>
            <span className="text-muted-foreground/60">/</span>
            <span className="text-muted-foreground">{m.assists}</span>
          </span>
          {m.acs > 0 && <>
            <span className="text-[10px] text-muted-foreground/60">·</span>
            <span className="text-[11px] text-cyan-400">{m.acs} ACS</span>
          </>}
          {m.adr > 0 && <>
            <span className="text-[10px] text-muted-foreground/60">·</span>
            <span className="text-[11px] text-cyan-400">{m.adr} ADR</span>
          </>}
          {m.hsPercent > 0 && <>
            <span className="text-[10px] text-muted-foreground/60">·</span>
            <span className="text-[11px] text-amber-400">{m.hsPercent}% HS</span>
          </>}
        </div>
      </div>
      <div className={`text-base font-bold ${m.won ? 'text-green-500' : 'text-red-500'}`}>
        {m.won ? 'W' : 'L'}
      </div>
    </div>
  )
}
