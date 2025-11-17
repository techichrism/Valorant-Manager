import { useState } from 'react'
import { LogIn, Download, Info, UserPlus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/toast'

export function AddAccountSection({ onLogin, onImport }) {
  const [loginLoading, setLoginLoading] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const toast = useToast()

  const handleLogin = async () => {
    setLoginLoading(true)
    try {
      const result = await onLogin()
      if (result?.success) {
        toast.success(`${result.account?.displayName || result.account?.username || 'Account'} added · ${result.account?.region}`)
      } else if (result?.error) {
        toast.error(result.error)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoginLoading(false)
    }
  }

  const handleImport = async () => {
    setImportLoading(true)
    try {
      const result = await onImport()
      if (result?.success) {
        toast.success(`${result.account?.displayName || result.account?.username || 'Account'} imported · ${result.account?.region}`)
      } else if (result?.error) {
        toast.error(result.error)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setImportLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Add Account</CardTitle>
        </div>
        <CardDescription>Opens the Riot Client to log in, or captures from a running session.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2 rounded-md border border-purple-500/40 bg-purple-500/10 dark:bg-purple-500/10 px-3 py-2">
          <Info className="h-3.5 w-3.5 text-purple-700 dark:text-purple-300 mt-0.5 shrink-0" />
          <p className="text-xs text-foreground">
            <span className="font-semibold">Always check "Stay signed in"</span> when logging in. Sessions last ~1-3 weeks.
          </p>
        </div>

        <Button onClick={handleLogin} disabled={loginLoading} className="w-full gap-1.5">
          <LogIn className="h-3.5 w-3.5" />
          {loginLoading ? 'Waiting for Riot Client login...' : 'Add Account'}
        </Button>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <Separator className="flex-1" />
        </div>

        <Button variant="outline" onClick={handleImport} disabled={importLoading} className="w-full gap-1.5">
          <Download className="h-3.5 w-3.5" />
          {importLoading ? 'Importing...' : 'Import from Riot Client'}
        </Button>
      </CardContent>
    </Card>
  )
}
