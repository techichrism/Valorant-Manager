import { useCallback, useEffect, useState } from 'react'
import { Settings, Menu, Eye, EyeOff, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

const TAB_TITLES = {
  accounts: { title: 'Nebula', subtitle: 'Valorant Account Manager' },
  match:    { title: 'Match Info', subtitle: 'Pre-game & in-game details' },
  store:    { title: 'Store & Nightmarket', subtitle: 'Daily offers and bonus store' },
  lookup:   { title: 'Player Lookup', subtitle: 'Find a player\'s past Riot IDs' },
}

export function Header({ onOpenSettings, onOpenMenu, activeTab = 'accounts' }) {
  const meta = TAB_TITLES[activeTab] || TAB_TITLES.accounts
  const toast = useToast()
  const [isOffline, setIsOffline] = useState(false)
  const [deceiveInstalled, setDeceiveInstalled] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        window.electronAPI.getPresenceState(),
        window.electronAPI.getDeceiveStatus(),
      ])
      if (p.success) setIsOffline(!!p.isOffline)
      if (d.success) setDeceiveInstalled(!!d.installed)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  const installDeceive = useCallback(async () => {
    setBusy(true)
    toast.info('Downloading Deceive from GitHub...', { duration: 15000 })
    try {
      const r = await window.electronAPI.installDeceive()
      if (r.success) {
        setDeceiveInstalled(true)
        toast.success(`Deceive ${r.version || ''} installed. Toggle Appear Offline now.`)
        return true
      }
      toast.error(`Install failed: ${r.error || 'unknown error'}`)
      return false
    } catch (e) {
      toast.error(`Install failed: ${e.message}`)
      return false
    } finally {
      setBusy(false)
    }
  }, [toast])

  const toggle = useCallback(async () => {
    if (busy) return
    // If enabling Appear Offline and Deceive isn't installed, offer to install
    if (!isOffline && !deceiveInstalled) {
      toast.info('Appear Offline requires Deceive. Click again to download it (~200KB).', { duration: 6000 })
      const ok = await installDeceive()
      if (!ok) return
    }
    setBusy(true)
    const next = !isOffline
    const r = await window.electronAPI.setAppearOffline(next)
    setBusy(false)
    if (r.success) {
      setIsOffline(!!r.isOffline)
      toast.success(
        next
          ? 'Appear Offline enabled. Launch Valorant via Nebula for it to take effect.'
          : 'Appear Offline disabled. Next Valorant launch will be normal.',
        { duration: 5000 }
      )
    } else {
      toast.error(r.error || 'Could not change presence.')
    }
  }, [busy, isOffline, deceiveInstalled, installDeceive, toast])

  const icon = !deceiveInstalled ? Download : (isOffline ? EyeOff : Eye)
  const IconComponent = icon
  const title = !deceiveInstalled
    ? 'Appear Offline — click to install Deceive (one-time download)'
    : isOffline
      ? 'Appearing offline (click to go online). Relaunch Valorant to apply.'
      : 'Online (click to appear offline). Relaunch Valorant to apply.'

  return (
    <header className="flex items-center justify-between pb-4 mb-4 border-b">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onOpenMenu} aria-label="Open menu">
          <Menu className="h-4 w-4" />
        </Button>
        <div key={activeTab} className="animate-fade-in">
          <h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1>
          <p className="text-xs text-muted-foreground">{meta.subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          disabled={busy}
          aria-label={title}
          title={title}
          className={isOffline ? 'text-purple-400' : (!deceiveInstalled ? 'text-muted-foreground' : '')}
        >
          <IconComponent className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Open settings">
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
