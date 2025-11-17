import { Users, Swords, Store, Search, X } from 'lucide-react'

// Sliding hamburger menu. Only the enabled tabs are shown. Account Manager
// is always present and is the default landing tab. Player Lookup is also
// always shown — it uses Henrikdev (third-party) so doesn't need the
// bannable Live API opt-in.
export function SideMenu({ open, onOpenChange, activeTab, onSelectTab, features }) {
  const items = [
    { key: 'accounts', label: 'Account Manager', desc: 'Your Valorant accounts', icon: Users, enabled: true },
    { key: 'match',    label: 'Match Info',      desc: 'Pre-game & in-game details', icon: Swords, enabled: !!features?.matchInfo },
    { key: 'store',    label: 'Store & Nightmarket', desc: 'Daily offers and bonus store', icon: Store, enabled: !!features?.store },
    { key: 'lookup',   label: 'Player Lookup',   desc: 'Find a player\'s past Riot IDs', icon: Search, enabled: true },
  ]

  const select = (key) => { onSelectTab(key); onOpenChange(false) }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ease-out ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => onOpenChange(false)}
      />

      {/* Drawer — translated beyond 100% so the border/shadow edge doesn't
          peek when closed */}
      <aside
        className={`fixed top-0 bottom-0 z-50 w-72 bg-background border-r transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-[calc(100%+2px)]'
        }`}
        style={{ left: 0 }}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-sm font-semibold">Nebula</h2>
            <p className="text-xs text-muted-foreground">Menu</p>
          </div>
          <button
            className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center"
            onClick={() => onOpenChange(false)}
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="p-2 flex flex-col gap-1">
          {items.filter(i => i.enabled).map((item) => {
            const Icon = item.icon
            const active = activeTab === item.key
            return (
              <button
                key={item.key}
                onClick={() => select(item.key)}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-md text-left transition-colors duration-150 ${
                  active
                    ? 'bg-purple-500/10 border border-purple-500/40'
                    : 'hover:bg-secondary/60 border border-transparent'
                }`}
              >
                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${active ? 'text-purple-500' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-none">{item.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
                </div>
              </button>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
