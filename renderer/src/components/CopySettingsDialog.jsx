import { useState, useEffect } from 'react'
import { Copy, ArrowRightLeft, ArrowDown, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

// UI categories are a simplified view over the backend's fine-grained key groups.
// "other" is a catch-all that expands to every non-primary category on the backend.
const OTHER_SUBCATS = ['audio', 'video', 'minimap', 'hud', 'gameplay']
const UI_CATEGORIES = [
  { key: 'crosshair',   label: 'Crosshair',   desc: 'All profiles, colors, outlines, dot, ADS variants' },
  { key: 'sensitivity', label: 'Sensitivity', desc: 'Mouse (normal, ADS, scoped), gamepad, invert' },
  { key: 'keybinds',    label: 'Keybinds',    desc: 'All action and movement key bindings' },
  { key: 'other',       label: 'Other',       desc: 'Audio, video quality, minimap, HUD, gameplay toggles' },
]
const DEFAULT_UI = { crosshair: true, sensitivity: true, keybinds: true, other: true }

// Expand UI selection into the backend's per-category flag map.
const expandToBackend = (ui) => ({
  crosshair:   !!ui.crosshair,
  sensitivity: !!ui.sensitivity,
  keybinds:    !!ui.keybinds,
  ...Object.fromEntries(OTHER_SUBCATS.map(k => [k, !!ui.other])),
})

function CategoryToggle({ checked, onChange, label, desc }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2.5 w-full text-left rounded-md border px-3 py-2 transition-colors ${
        checked ? 'border-purple-500/50 bg-purple-500/10' : 'border-border hover:bg-secondary/50'
      }`}
    >
      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
        checked ? 'bg-purple-500 border-purple-500' : 'border-muted-foreground/40'
      }`}>
        {checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-none">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
    </button>
  )
}

export function CopySettingsDialog({ open, onOpenChange, targetAccount, accounts }) {
  const [sourceId, setSourceId] = useState('')
  const [copying, setCopying] = useState(false)
  const [categories, setCategories] = useState(DEFAULT_UI)
  const toast = useToast()

  useEffect(() => {
    if (open) {
      setSourceId('')
      setCategories(DEFAULT_UI)
    }
  }, [open])

  const otherAccounts = accounts.filter(a => a.id !== targetAccount?.id)
  const anySelected = Object.values(categories).some(Boolean)

  const handleCopyCloud = async () => {
    if (!sourceId) return toast.error('Select an account to copy from.')
    if (!anySelected) return toast.error('Select at least one category.')
    setCopying(true)
    try {
      const result = await window.electronAPI.copyCloudSettings(sourceId, targetAccount.id, expandToBackend(categories))
      if (result.success) {
        const selected = UI_CATEGORIES.filter(c => categories[c.key]).map(c => c.label.toLowerCase()).join(', ')
        toast.success(`Copied ${selected}. Restart Valorant to apply.`)
        // Cloud copy succeeded; this is a soft warning about the local-file
        // mirror step (e.g. target hasn't launched Valorant on this PC yet).
        // Show it as info, not error — the cloud copy is the source of truth.
        if (result.localMergeWarning) toast.info(result.localMergeWarning, { duration: 8000 })
        onOpenChange(false)
      } else toast.error(result.error)
    } catch (e) { toast.error(e.message) }
    finally { setCopying(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Copy Settings
          </DialogTitle>
          <DialogDescription>
            Copy settings to <strong>{targetAccount?.displayName || targetAccount?.username}</strong>{targetAccount?.nickname ? ` (${targetAccount.nickname})` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
              Copy from
            </label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select account..." />
              </SelectTrigger>
              <SelectContent>
                {otherAccounts.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName || a.username}{a.nickname ? ` (${a.nickname})` : ''} · {a.region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Categories</label>
            <div className="grid grid-cols-2 gap-2">
              {UI_CATEGORIES.map(c => (
                <CategoryToggle
                  key={c.key}
                  checked={categories[c.key]}
                  onChange={v => setCategories(prev => ({ ...prev, [c.key]: v }))}
                  label={c.label}
                  desc={c.desc}
                />
              ))}
            </div>
          </div>

          <Button onClick={handleCopyCloud} disabled={copying || !sourceId || !anySelected} className="w-full gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            {copying ? 'Copying...' : 'Copy Selected'}
          </Button>
          <p className="text-xs text-muted-foreground -mt-2">
            Both accounts need active sessions. Restart Valorant to apply.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
