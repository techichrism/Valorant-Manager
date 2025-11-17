import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, X, Heart, Store, ImageOff } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'

// Fallback image component — shows the real icon if it loads, or a muted
// "image off" silhouette if the URL is missing or 404s. Earlier used the
// Package icon which at small sizes looked like a delete X to users; the
// ImageOff icon is unambiguous.
function SkinThumb({ src, alt }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  if (!src || failed) {
    return (
      <div className="h-8 w-16 rounded bg-secondary/60 flex items-center justify-center shrink-0">
        <ImageOff className="h-3.5 w-3.5 text-muted-foreground/40" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-8 w-16 object-contain shrink-0"
    />
  )
}

// Browse every buyable skin in the game, search by name/weapon, toggle
// hearts to add/remove from the wishlist. The backend catalog is cached
// for the app's lifetime after first open, so subsequent opens are instant.
export function WishlistBrowserDialog({ open, onOpenChange, wishlist, accountId, onChange }) {
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyWishlisted, setOnlyWishlisted] = useState(false)
  const toast = useToast()

  // Load the full catalog the first time the dialog is opened. Passes the
  // selected account id so the backend can cross-reference with /store/v1/offers
  // and return only currently-buyable skins (no battlepass, VCT, agent
  // contract rewards, etc.).
  useEffect(() => {
    if (!open || catalog) return
    let cancelled = false
    setLoading(true)
    window.electronAPI.getSkinCatalog(accountId)
      .then(r => {
        if (cancelled) return
        if (r.success) setCatalog(r.catalog || [])
        else toast.error(r.error || 'Failed to load skin catalog.')
      })
      .catch(e => { if (!cancelled) toast.error(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, catalog, accountId, toast])

  // Reset UI state when closed
  useEffect(() => {
    if (!open) {
      setQuery('')
      setOnlyWishlisted(false)
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!catalog) return []
    let list = catalog
    if (onlyWishlisted) list = list.filter(s => wishlist[s.uuid])
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.weapon.toLowerCase().includes(q)
      )
    }
    return list
  }, [catalog, query, onlyWishlisted, wishlist])

  // Group filtered results by weapon for nicer display
  const grouped = useMemo(() => {
    const map = new Map()
    for (const skin of filtered) {
      if (!map.has(skin.weapon)) map.set(skin.weapon, [])
      map.get(skin.weapon).push(skin)
    }
    return map
  }, [filtered])

  const handleToggle = useCallback(async (skin) => {
    try {
      if (wishlist[skin.uuid]) {
        await window.electronAPI.removeFromWishlist(skin.uuid)
      } else {
        await window.electronAPI.addToWishlist({ uuid: skin.uuid, name: skin.name })
      }
      onChange && onChange()
    } catch (e) {
      toast.error(e.message)
    }
  }, [wishlist, onChange, toast])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-3 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Store className="h-4 w-4" />
            Browse Skins
          </DialogTitle>
          <DialogDescription>
            Search any skin and add it to your wishlist. You'll get a toast whenever a wishlisted skin shows up in any account's daily store.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-3 shrink-0">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by skin or weapon (e.g. Vandal, Reaver, Phantom)..."
              className="w-full h-9 pl-9 pr-9 rounded-md border bg-secondary/30 text-sm focus:outline-none focus:border-purple-500/50 transition-colors"
              spellCheck={false}
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded hover:bg-secondary flex items-center justify-center"
                title="Clear"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          {catalog && !loading && (
            <div className="flex items-center justify-between gap-2 mt-2">
              <p className="text-[11px] text-muted-foreground">
                {filtered.length !== catalog.length
                  ? `${filtered.length} of ${catalog.length} skins`
                  : `${catalog.length} skins`}
                {' · '}
                {Object.keys(wishlist).length} in wishlist
              </p>
              <button
                type="button"
                onClick={() => setOnlyWishlisted(v => !v)}
                className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border transition-colors ${
                  onlyWishlisted
                    ? 'border-pink-500/50 bg-pink-500/10 text-pink-400'
                    : 'border-border text-muted-foreground hover:bg-secondary/60'
                }`}
                title="Show only skins on your wishlist"
              >
                <Heart className={`h-3 w-3 ${onlyWishlisted ? 'fill-pink-500 text-pink-500' : ''}`} />
                Wishlisted only
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          {loading && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <div className="grid grid-cols-2 gap-2">
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && catalog && filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">
              {onlyWishlisted && !query
                ? 'No skins on your wishlist yet.'
                : onlyWishlisted && query
                ? <>No wishlisted skins match "<span className="text-foreground">{query}</span>".</>
                : <>No skins match "<span className="text-foreground">{query}</span>".</>}
            </p>
          )}

          {!loading && grouped.size > 0 && Array.from(grouped.entries()).map(([weapon, skins]) => (
            <section key={weapon} className="space-y-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sticky top-0 bg-background/95 backdrop-blur py-1">
                {weapon} ({skins.length})
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {skins.map(skin => {
                  const wished = !!wishlist[skin.uuid]
                  return (
                    <button
                      key={skin.uuid}
                      type="button"
                      onClick={() => handleToggle(skin)}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                        wished
                          ? 'border-pink-500/50 bg-pink-500/10 hover:bg-pink-500/15'
                          : 'border-border bg-card/50 hover:bg-card hover:border-purple-500/30'
                      }`}
                    >
                      <SkinThumb src={skin.icon} alt={skin.name} />
                      <p className="text-xs font-medium truncate flex-1" title={skin.name}>
                        {skin.name}
                      </p>
                      <Heart className={`h-3.5 w-3.5 shrink-0 ${wished ? 'fill-pink-500 text-pink-500' : 'text-muted-foreground'}`} />
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

