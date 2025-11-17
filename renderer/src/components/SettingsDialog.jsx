import { useState, useEffect } from 'react'
import { CheckCircle2, XCircle, Settings2, FolderCog, Palette, Rocket, Sun, Moon, Monitor, Save, Store, Swords, Key, Timer } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/hooks/useTheme.jsx'
import { useToast } from '@/components/ui/toast'

export function SettingsDialog({ open, onOpenChange, onSaved }) {
  const { theme, setTheme } = useTheme()
  const [riotClientPath, setRiotClientPath] = useState('')
  const [localTheme, setLocalTheme] = useState(theme)
  const [autoLaunch, setAutoLaunch] = useState(true)
  const [enableStore, setEnableStore] = useState(false)
  const [enableMatchInfo, setEnableMatchInfo] = useState(false)
  const [henrikdevApiKey, setHenrikdevApiKey] = useState('')
  const [autoRefreshOn, setAutoRefreshOn] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (open) {
      window.electronAPI.getSettings().then(s => {
        setRiotClientPath(s.riotClientPath || '')
        setLocalTheme(s.theme || 'system')
        setAutoLaunch(s.autoLaunchValorant !== false)
        setEnableStore(!!s.enableStoreFeature)
        setEnableMatchInfo(!!s.enableMatchInfoFeature)
        setHenrikdevApiKey(s.henrikdevApiKey || '')
        setAutoRefreshOn(!!s.matchInfoAutoRefresh)
      })
    }
  }, [open])

  const handleSave = async () => {
    setSaving(true)
    const result = await window.electronAPI.saveSettings({
      theme: localTheme,
      autoLaunchValorant: autoLaunch,
      enableStoreFeature: enableStore,
      enableMatchInfoFeature: enableMatchInfo,
      henrikdevApiKey,
      matchInfoAutoRefresh: autoRefreshOn,
    })
    setSaving(false)
    if (result.success) {
      setTheme(localTheme)
      toast.success('Settings saved.')
      if (onSaved) onSaved()
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Settings
          </DialogTitle>
          <DialogDescription>Configure Nebula preferences.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <FolderCog className="h-3.5 w-3.5 text-muted-foreground" />
              Riot Client
            </label>
            <div className="flex items-center gap-2 h-9 px-3 rounded-md border bg-secondary/50 text-sm overflow-hidden">
              {riotClientPath ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <span className="text-foreground truncate text-xs">{riotClientPath}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <span className="text-muted-foreground">Not detected. Install Riot Games.</span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Auto-detected from Riot Games installation.</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5 text-muted-foreground" />
              Theme
            </label>
            <Select value={localTheme} onValueChange={setLocalTheme}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system"><span className="flex items-center gap-2"><Monitor className="h-3.5 w-3.5" />System</span></SelectItem>
                <SelectItem value="light"><span className="flex items-center gap-2"><Sun className="h-3.5 w-3.5" />Light</span></SelectItem>
                <SelectItem value="dark"><span className="flex items-center gap-2"><Moon className="h-3.5 w-3.5" />Dark</span></SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2 flex-1">
              <Rocket className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <label className="text-sm font-medium">Auto-Launch Valorant</label>
                <p className="text-xs text-muted-foreground">Start Valorant automatically when launching an account.</p>
              </div>
            </div>
            <Switch checked={autoLaunch} onCheckedChange={setAutoLaunch} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2 flex-1">
              <Timer className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <label className="text-sm font-medium">Auto-Refresh (15s)</label>
                <p className="text-xs text-muted-foreground">
                  Refresh account ranks and RR every 15s on the Accounts tab.
                  {enableMatchInfo ? ' Also refreshes Match Info while you\'re on that tab.' : ''}
                </p>
              </div>
            </div>
            <Switch checked={autoRefreshOn} onCheckedChange={setAutoRefreshOn} />
          </div>

          <Separator />

          {/* Henrikdev API key — used by Player Lookup, Blacklist-by-Riot-ID,
              and Match Info hidden-name fallback. Top-level (not under the
              Live API gate) since the first two work without any Riot live
              endpoint involvement. */}
          <div className="flex items-start gap-2">
            <Key className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <label className="text-sm font-medium">
                Henrikdev API key <span className="text-muted-foreground font-normal text-xs">(optional)</span>
              </label>
              <input
                type="password"
                value={henrikdevApiKey}
                onChange={(e) => setHenrikdevApiKey(e.target.value)}
                placeholder="HDEV-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full h-8 px-2.5 rounded-md border bg-secondary/50 text-xs font-mono focus:outline-none focus:border-purple-500/50 transition-colors"
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Powers Player Lookup, blacklist-by-Riot-ID, and the hidden-name fallback in Match Info.
                Free key at{' '}
                <button
                  type="button"
                  onClick={() => window.electronAPI.openExternalLink('https://docs.henrikdev.xyz/')}
                  className="text-purple-500 hover:underline"
                >
                  docs.henrikdev.xyz
                </button>
                .
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Live API features</p>
              <p className="text-[11px] text-amber-500 mt-0.5">⚠ Could be bannable — low chance, use at your own risk</p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 flex-1">
                <Store className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <label className="text-sm font-medium">Store & Nightmarket</label>
                  <p className="text-xs text-muted-foreground">View daily offers and Nightmarket for any account. Uses Riot's live API.</p>
                </div>
              </div>
              <Switch checked={enableStore} onCheckedChange={setEnableStore} />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 flex-1">
                <Swords className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <label className="text-sm font-medium">Match Info</label>
                  <p className="text-xs text-muted-foreground">See players, agents, map, and side in pre-game or in-game. Uses Riot's live API.</p>
                </div>
              </div>
              <Switch checked={enableMatchInfo} onCheckedChange={setEnableMatchInfo} />
            </div>
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full gap-1.5">
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
