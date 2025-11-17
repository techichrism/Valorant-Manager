import { useState, useCallback } from 'react'

export function useAccounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await window.electronAPI.getAccounts()
      if (!Array.isArray(data)) { setAccounts([]); return }
      // Sort by sortOrder, then lastUsed as fallback
      const sorted = [...data].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
      setAccounts(sorted)
    } catch (err) {
      console.error('Failed to load accounts:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const removeAccount = useCallback(async (accountId) => {
    const result = await window.electronAPI.removeAccount(accountId)
    if (result.success) setAccounts(prev => prev.filter(a => a.id !== accountId))
    return result
  }, [])

  const loginWithRiot = useCallback(async () => {
    const result = await window.electronAPI.loginWithRiot()
    if (result.success) await fetchAccounts()
    return result
  }, [fetchAccounts])

  const importAccount = useCallback(async () => {
    const result = await window.electronAPI.importCurrentAccount()
    if (result.success) await fetchAccounts()
    return result
  }, [fetchAccounts])

  const launchValorant = useCallback(async (id) => {
    return await window.electronAPI.launchValorant(id)
  }, [])

  const setNickname = useCallback(async (id, nickname) => {
    const result = await window.electronAPI.setNickname(id, nickname)
    if (result.success) {
      setAccounts(prev => prev.map(a => a.id === id ? { ...a, nickname } : a))
    }
    return result
  }, [])

  const reorderAccounts = useCallback(async (orderedIds) => {
    const result = await window.electronAPI.reorderAccounts(orderedIds)
    if (result.success) {
      setAccounts(prev => {
        const map = new Map(prev.map(a => [a.id, a]))
        return orderedIds.map(id => map.get(id)).filter(Boolean)
      })
    }
    return result
  }, [])

  const checkSession = useCallback(async (id) => {
    return await window.electronAPI.checkSession(id)
  }, [])

  return { accounts, loading, fetchAccounts, removeAccount, loginWithRiot, importAccount, launchValorant, setNickname, reorderAccounts, checkSession }
}
