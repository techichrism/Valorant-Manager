import { useCallback, useMemo, useState } from 'react'
import { Users, Search, X } from 'lucide-react'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { AccountCard } from '@/components/AccountCard'

// Loading skeleton that mimics the AccountCard row layout: grip, rank icon,
// name/meta stack, and launch button. Shows 4 placeholder rows.
function AccountListSkeleton() {
  return (
    <div className="px-3 pb-3 space-y-0">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          {i > 0 && <Separator />}
          <div className="flex items-center py-3 px-1 gap-2">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-44" />
            </div>
            <Skeleton className="h-8 w-[90px] shrink-0 ml-1" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AccountList({ accounts, loading, statuses, ranks = {}, sessions = {}, onLaunch, onRemove, onCopySettings, onSetNickname, onCheckSession, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [query, setQuery] = useState('')

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event
    if (active.id !== over?.id) {
      const oldIndex = accounts.findIndex(a => a.id === active.id)
      const newIndex = accounts.findIndex(a => a.id === over.id)
      const reordered = arrayMove(accounts, oldIndex, newIndex)
      onReorder(reordered.map(a => a.id))
    }
  }, [accounts, onReorder])

  // Filter by name/nickname/region. Case-insensitive substring match, plus
  // a dedicated "rank:<name>" token that filters by current rank tier.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return accounts
    // Special syntax: `rank:immortal` → matches accounts whose current rank name includes "immortal"
    if (q.startsWith('rank:')) {
      const rankTerm = q.slice(5).trim()
      if (!rankTerm) return accounts
      return accounts.filter(a => ranks[a.id]?.current?.name?.toLowerCase().includes(rankTerm))
    }
    return accounts.filter(a => {
      const id = `${a.displayName || a.username || ''} ${a.nickname || ''} ${a.region || ''}`.toLowerCase()
      return id.includes(q)
    })
  }, [accounts, query, ranks])

  // Drag-and-drop only makes sense when viewing the unfiltered list —
  // reordering a subset is confusing. Disable dnd when search is active.
  const dndEnabled = !query.trim()

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Accounts</CardTitle>
          {accounts.length > 0 && (
            <span className="text-xs text-muted-foreground ml-auto">
              {filtered.length !== accounts.length ? `${filtered.length}/${accounts.length}` : accounts.length}
            </span>
          )}
        </div>
        {accounts.length > 0 && (
          <div className="relative">
            <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, nickname, region, or rank:diamond"
              className="w-full h-7 pl-7 pr-7 rounded-md border bg-secondary/30 text-xs focus:outline-none focus:border-purple-500/50 transition-colors"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded hover:bg-secondary flex items-center justify-center"
                title="Clear"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 flex flex-col">
        {loading ? (
          <AccountListSkeleton />
        ) : accounts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <p className="text-sm text-muted-foreground">No accounts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Add one below to get started</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <p className="text-sm text-muted-foreground">No matches</p>
            <p className="text-xs text-muted-foreground mt-1">Try a different search</p>
          </div>
        ) : (
          <ScrollArea className="h-full px-3 pb-3">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dndEnabled ? handleDragEnd : undefined}>
              <SortableContext items={filtered.map(a => a.id)} strategy={verticalListSortingStrategy}>
                {filtered.map((account, i) => (
                  <div key={account.id}>
                    {i > 0 && <Separator />}
                    <AccountCard
                      account={account}
                      launchStatus={(statuses[account.id] || {}).status || 'idle'}
                      rank={ranks[account.id]}
                      session={sessions[account.id]}
                      dndEnabled={dndEnabled}
                      onLaunch={onLaunch}
                      onRemove={onRemove}
                      onCopySettings={onCopySettings}
                      onSetNickname={onSetNickname}
                      onCheckSession={onCheckSession}
                    />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
