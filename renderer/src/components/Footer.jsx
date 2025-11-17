import { useEffect, useState } from 'react'

export function Footer({ status }) {
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI.getAppVersion?.().then(setVersion).catch(() => {})
  }, [])

  return (
    <footer className="mt-4 pt-3 border-t flex items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground truncate">{status || 'Ready'}</p>
      {version && <p className="text-xs text-muted-foreground shrink-0">v{version}</p>}
    </footer>
  )
}
