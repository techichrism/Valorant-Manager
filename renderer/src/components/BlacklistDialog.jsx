import { useState, useEffect, useCallback } from 'react'
import { Ban, Trash2, Users, UserPlus, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/toast'

function formatDate(ts) {
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ts))
  } catch { return '' }
}

// Management view for the blacklist. Two ways to add entries:
//   1. From the Match Info player stats dialog (where we already have a puuid)
//   2. By Riot ID right here (resolves name#tag → puuid via Henrikdev)
// Both paths produce puuid-keyed entries so flagging survives Riot ID changes.
export function BlacklistDialog({ open, onOpenChange, onChange }) {
  const [entries, setEntries] = useState({})
  const [riotIdInput, setRiotIdInput] = useState('')
  const [reasonInput, setReasonInput] = useState('')
  const [adding, setAdding] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const r = await window.electronAPI.getBlacklist()
      if (r.success) setEntries(r.blacklist || {})
    } catch (e) { toast.error(e.message) }
  }, [toast])

  useEffect(() => { if (open) load() }, [open, load])

  // Reset the form when the dialog closes so reopening shows a clean slate.
  useEffect(() => {
    if (!open) {
      setRiotIdInput('')
      setReasonInput('')
      setAdding(false)
    }
  }, [open])

  const handleRemove = async (puuid) => {
    try {
      await window.electronAPI.removeFromBlacklist(puuid)
      toast.success('Removed')
      await load()
      onChange && onChange()
    } catch (e) { toast.error(e.message) }
  }

  const handleAddByRiotId = async () => {
    const trimmed = riotIdInput.trim()
    if (!trimmed) return
    setAdding(true)
    try {
      const r = await window.electronAPI.addToBlacklistByRiotId({
        riotId: trimmed,
        reason: reasonInput.trim(),
      })
      if (r.success) {
        toast.success(`${r.name} added to blacklist`)
        setRiotIdInput('')
        setReasonInput('')
        await load()
        onChange && onChange()
      } else {
        toast.error(r.error || 'Failed to add player.')
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setAdding(false)
    }
  }

  const canSubmit = riotIdInput.trim().includes('#') && !adding

  const entryList = Object.entries(entries).sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4" />
            Blacklist
          </DialogTitle>
          <DialogDescription>
            Players flagged here trigger a warning when they appear in your match.
            Add someone by Riot ID below, or via their row in Match Info.
          </DialogDescription>
        </DialogHeader>

        {/* Add by Riot ID — needs a Henrikdev API key (configured in Settings)
            because Riot's own APIs don't expose a name → puuid lookup we can hit. */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center gap-1.5">
            <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Add by Riot ID</h3>
          </div>
          <div className="space-y-1.5">
            <input
              type="text"
              value={riotIdInput}
              onChange={(e) => setRiotIdInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleAddByRiotId() }}
              placeholder="name#tag (e.g. v1ni#cius)"
              disabled={adding}
              className="w-full h-8 px-2.5 rounded-md border bg-secondary/50 text-xs focus:outline-none focus:border-purple-500/50 transition-colors disabled:opacity-60"
              spellCheck={false}
              autoComplete="off"
            />
            <input
              type="text"
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleAddByRiotId() }}
              placeholder="Reason (optional)"
              disabled={adding}
              className="w-full h-8 px-2.5 rounded-md border bg-secondary/50 text-xs focus:outline-none focus:border-purple-500/50 transition-colors disabled:opacity-60"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              onClick={handleAddByRiotId}
              disabled={!canSubmit}
              className="w-full h-8 gap-1.5"
            >
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              {adding ? 'Looking up...' : 'Blacklist'}
            </Button>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Lookup uses your Henrikdev API key from Settings. Set one there first if you haven't.
            </p>
          </div>
        </div>

        <Separator className="my-1" />

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 mb-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Blacklisted</h3>
            <span className="text-xs text-muted-foreground">({entryList.length})</span>
          </div>
          {entryList.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No one's on your blacklist yet.
            </p>
          ) : (
            entryList.map(([puuid, entry]) => (
              <div key={puuid} className="flex items-start gap-2 rounded-md border bg-card/50 px-2.5 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{entry.name || 'Unknown'}</p>
                  {entry.reason && <p className="text-[11px] text-muted-foreground truncate italic">"{entry.reason}"</p>}
                  <p className="text-[10px] text-muted-foreground mt-0.5">Added {formatDate(entry.addedAt)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => handleRemove(puuid)}
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
