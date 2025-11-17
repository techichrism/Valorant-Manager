import { useState, useEffect, useCallback } from 'react'
import { Store, Moon, RefreshCw, Clock, Package, Heart, CheckCircle2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { WishlistBrowserDialog } from '@/components/WishlistBrowserDialog'

function formatRemaining(seconds) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// Fixed-height image area (h-28) keeps every card the same size regardless
// of source-image aspect (skin = wide, buddy = square, card = wide, spray
// = square/portrait). object-contain centers and letterboxes inside.
function SkinCard({ item, subtitle, onToggleWishlist, wishlisted }) {
  const handleHeart = (e) => {
    e.stopPropagation()
    onToggleWishlist(item)
  }
  return (
    <div className={`relative flex flex-col rounded-md border bg-card overflow-hidden transition-colors duration-150 ${
      item.owned ? 'border-green-500/40' : 'hover:border-purple-500/40'
    }`}>
      <div className="h-28 bg-secondary/40 flex items-center justify-center p-3">
        {item.icon ? (
          <img
            src={item.icon}
            alt={item.name}
            loading="lazy"
            className={`max-h-full max-w-full object-contain ${item.owned ? 'opacity-50' : ''}`}
          />
        ) : (
          <Store className="h-6 w-6 text-muted-foreground" />
        )}
      </div>
      {item.owned && (
        <div className="absolute top-1.5 left-1.5 bg-green-500/90 text-white text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded flex items-center gap-1">
          <CheckCircle2 className="h-2.5 w-2.5" />
          Owned
        </div>
      )}
      {onToggleWishlist && (
        <button
          type="button"
          onClick={handleHeart}
          className={`absolute top-1.5 right-1.5 h-6 w-6 rounded-full flex items-center justify-center transition-colors ${
            wishlisted
              ? 'bg-pink-500/90 text-white'
              : 'bg-black/40 text-white/60 hover:bg-black/60 hover:text-white'
          }`}
          title={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
        >
          <Heart className={`h-3 w-3 ${wishlisted ? 'fill-current' : ''}`} />
        </button>
      )}
      <div className="p-2.5 flex flex-col gap-0.5">
        <p className="text-xs font-semibold leading-tight line-clamp-2 text-foreground" title={item.name}>{item.name}</p>
        <p className="text-[11px] font-medium text-purple-400">{subtitle}</p>
      </div>
    </div>
  )
}

function StoreSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-md border overflow-hidden">
              <Skeleton className="h-28 rounded-none" />
              <div className="p-2.5 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-12" />
        </div>
        <Skeleton className="aspect-[3/1] rounded-md" />
      </section>
    </div>
  )
}

function BundleSection({ bundle, wishlist, onToggleWishlist }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5 text-amber-400" />
          {bundle.name || 'Featured Bundle'}
        </h3>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3 text-purple-400/60" /> {formatRemaining(bundle.remainingSeconds)}
        </span>
      </div>
      {bundle.icon && (
        <div className="relative rounded-md overflow-hidden border">
          <img src={bundle.icon} alt={bundle.name} className="w-full h-auto object-cover" />
          <div className="absolute bottom-2 right-2 bg-black/70 backdrop-blur px-2.5 py-1.5 rounded text-xs">
            <span className="line-through text-muted-foreground/70 mr-1.5">{bundle.totalPrice.toLocaleString()}</span>
            <span className="font-bold text-white">{bundle.discountedTotal.toLocaleString()} VP</span>
            {bundle.discountPct > 0 && (
              <span className="ml-1.5 font-bold text-green-400">-{bundle.discountPct}%</span>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {bundle.items.map(item => (
          <SkinCard
            key={item.uuid}
            item={item}
            subtitle={`${(item.basePrice || 0).toLocaleString()} VP`}
            wishlisted={!!wishlist[item.uuid]}
            // Hearts only on skins — the daily-store wishlist notifier
            // matches by skin uuid; buddies/sprays/cards never rotate there.
            onToggleWishlist={item.kind === 'skin' ? onToggleWishlist : undefined}
          />
        ))}
      </div>
    </section>
  )
}

export function StoreTab({ accounts }) {
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [store, setStore] = useState(null)
  const [wishlist, setWishlist] = useState({})
  const [browserOpen, setBrowserOpen] = useState(false)
  const toast = useToast()

  // Auto-select first account when tab mounts. Also recovers from the
  // case where the previously-selected account got removed: if `selectedId`
  // no longer maps to any current account, snap to the first available
  // (or clear when no accounts remain) so subsequent fetches don't 404.
  useEffect(() => {
    if (!accounts.length) {
      if (selectedId) setSelectedId('')
      return
    }
    if (!accounts.some(a => a.id === selectedId)) setSelectedId(accounts[0].id)
  }, [accounts, selectedId])

  // Load the persistent wishlist on mount
  const loadWishlist = useCallback(async () => {
    try {
      const r = await window.electronAPI.getWishlist()
      if (r.success) setWishlist(r.wishlist || {})
    } catch { /* silent */ }
  }, [])
  useEffect(() => { loadWishlist() }, [loadWishlist])

  const fetchStore = useCallback(async () => {
    if (!selectedId) return
    setLoading(true)
    setStore(null)
    try {
      const result = await window.electronAPI.getStore(selectedId)
      if (result.success) setStore(result.store)
      else toast.error(result.error || 'Failed to load store.')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [selectedId, toast])

  useEffect(() => {
    if (selectedId) fetchStore()
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the store loads, check daily items against the wishlist and surface
  // a prominent toast if any are a hit. Uses state so we don't re-notify on
  // every render — only once per store fetch.
  useEffect(() => {
    if (!store?.daily?.items) return
    const hits = store.daily.items.filter(item => wishlist[item.uuid] && !item.owned)
    if (hits.length) {
      const names = hits.map(h => h.name).join(', ')
      toast.success(`⭐ Wishlist hit: ${names}`, { duration: 15000 })
    }
  }, [store, wishlist, toast])

  const handleToggleWishlist = async (item) => {
    try {
      if (wishlist[item.uuid]) {
        await window.electronAPI.removeFromWishlist(item.uuid)
        toast.info(`Removed ${item.name} from wishlist`)
      } else {
        await window.electronAPI.addToWishlist({ uuid: item.uuid, name: item.name })
        toast.success(`${item.name} added to wishlist`)
      }
      await loadWishlist()
    } catch (e) {
      toast.error(e.message)
    }
  }

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
        <Button variant="outline" size="icon" onClick={() => setBrowserOpen(true)} title="Browse all skins">
          <Heart className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={fetchStore} disabled={loading || !selectedId} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loading && !store && <StoreSkeleton />}

      {store && (
        <div className="flex flex-col gap-4">
          {/* Daily featured */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Store className="h-3.5 w-3.5 text-purple-400" />
                Daily Offers
              </h3>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3 text-purple-400/60" /> {formatRemaining(store.daily?.remainingSeconds)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(store.daily?.items || []).map(item => (
                <SkinCard
                  key={item.uuid}
                  item={item}
                  subtitle={`${item.cost.toLocaleString()} VP`}
                  wishlisted={!!wishlist[item.uuid]}
                  onToggleWishlist={handleToggleWishlist}
                />
              ))}
            </div>
          </section>

          {/* Featured bundles (usually 1 at a time) */}
          {store.featuredBundles?.length > 0 && store.featuredBundles.map(b => (
            <BundleSection
              key={b.uuid}
              bundle={b}
              wishlist={wishlist}
              onToggleWishlist={handleToggleWishlist}
            />
          ))}

          {/* Nightmarket */}
          {store.nightmarket ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Moon className="h-3.5 w-3.5 text-purple-400" />
                  Nightmarket
                </h3>
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3 text-purple-400/60" /> {formatRemaining(store.nightmarket.remainingSeconds)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {store.nightmarket.items.map(item => (
                  <SkinCard
                    key={item.uuid}
                    item={item}
                    subtitle={
                      <span>
                        <span className="line-through text-muted-foreground/40 mr-1">{item.basePrice?.toLocaleString()}</span>
                        {item.discountedPrice.toLocaleString()} VP
                        <span className="text-green-400 font-semibold ml-1.5">-{item.discountPercent}%</span>
                      </span>
                    }
                    wishlisted={!!wishlist[item.uuid]}
                    onToggleWishlist={handleToggleWishlist}
                  />
                ))}
              </div>
            </section>
          ) : (
            <section className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Moon className="h-3.5 w-3.5 text-muted-foreground/40" />
                <h3 className="text-sm font-semibold text-muted-foreground">Nightmarket</h3>
              </div>
              <div className="rounded-md border border-dashed bg-secondary/20 p-4 text-center space-y-1">
                <p className="text-sm text-muted-foreground">Not available right now</p>
                <p className="text-xs text-muted-foreground/60">
                  Riot runs it for ~2 weeks roughly once per act.
                </p>
              </div>
            </section>
          )}
        </div>
      )}

      <WishlistBrowserDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        wishlist={wishlist}
        accountId={selectedId}
        onChange={loadWishlist}
      />
    </div>
  )
}
