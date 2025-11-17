import { useState, useEffect, useCallback } from 'react'

export function useLaunchStatus() {
  const [statuses, setStatuses] = useState({})

  useEffect(() => {
    const handler = (accountId, status, message) => {
      setStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
    }
    window.electronAPI.onUpdateLaunchStatus(handler)
    return () => window.electronAPI.removeUpdateLaunchStatusListener()
  }, [])

  const setStatus = useCallback((accountId, status, message = '') => {
    setStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
  }, [])

  return { statuses, setStatus }
}
