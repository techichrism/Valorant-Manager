import { useState, useEffect } from 'react'
import { MinusCircle, LogOut, Power } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function CloseDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    window.electronAPI.onConfirmClose(() => setOpen(true))
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Power className="h-4 w-4" />
            Close Nebula
          </DialogTitle>
          <DialogDescription>Keep running in the background or quit completely?</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-2">
          <Button variant="outline" onClick={() => { setOpen(false); window.electronAPI.minimizeToTray() }} className="w-full gap-2 justify-start">
            <MinusCircle className="h-4 w-4" />
            Minimize to Tray
          </Button>
          <Button variant="ghost" onClick={() => { setOpen(false); window.electronAPI.quitApp() }} className="w-full gap-2 justify-start text-muted-foreground hover:text-destructive">
            <LogOut className="h-4 w-4" />
            Quit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
