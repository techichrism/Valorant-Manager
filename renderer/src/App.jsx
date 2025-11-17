import { useState, useEffect, useCallback, useRef } from 'react'
import { ThemeProvider } from '@/hooks/useTheme.jsx'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useLaunchStatus } from '@/hooks/useLaunchStatus'
import { Header } from '@/components/Header'
import { SideMenu } from '@/components/SideMenu'
import { AccountList } from '@/components/AccountList'
import { AddAccountSection } from '@/components/AddAccountSection'
import { SettingsDialog } from '@/components/SettingsDialog'
import { CopySettingsDialog } from '@/components/CopySettingsDialog'
import { NicknameDialog } from '@/components/NicknameDialog'
import { Footer } from '@/components/Footer'
import { CloseDialog } from '@/components/CloseDialog'
import { StoreTab } from '@/components/StoreTab'
import { MatchInfoTab } from '@/components/MatchInfoTab'
import { PlayerLookupTab } from '@/components/PlayerLookupTab'

function AppContent() {
  const { accounts, loading, fetchAccounts, removeAccount, loginWithRiot, importAccount, launchValorant, setNickname, reorderAccounts, checkSession } = useAccounts()
  const { statuses, setStatus } = useLaunchStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('accounts')
  const [features, setFeatures] = useState({ store: false, matchInfo: false })
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [accountRanks, setAccountRanks] = useState({}) // accountId → { current, peak }
  const [accountSessions, setAccountSessions] = useState({}) // accountId → today's stats
  const [copyTarget, setCopyTarget] = useState(null)
  const [nicknameTarget, setNicknameTarget] = useState(null)
  const [appStatus, setAppStatus] = useState('Ready')
  const toast = useToast()

  // Refresh feature flags — called on mount and after saving settings so the
  // hamburger menu and active tab react to the toggles immediately.
  const refreshFeatures = useCallback(async () => {
    const s = await window.electronAPI.getSettings()
    setFeatures({ store: !!s.enableStoreFeature, matchInfo: !!s.enableMatchInfoFeature })
    setAutoRefresh(!!s.matchInfoAutoRefresh)
    return s
  }, [])

  useEffect(() => {
    fetchAccounts()
    refreshFeatures().then(s => {
      if (!s.riotClientPath) {
        toast.error('Riot Client not found. Make sure Riot Games is installed.')
      }
    })

    // Auto-updater notifications
    window.electronAPI.onUpdateStatus?.((info) => {
      if (info.type === 'available') {
        toast.info(`Update available: v${info.version}. Downloading...`)
      } else if (info.type === 'downloaded') {
        toast.success(`Update v${info.version} ready. Restart to install.`, {
          duration: 0,
          action: { label: 'Restart now', onClick: () => window.electronAPI.installUpdateNow() },
        })
      }
    })
  }, [fetchAccounts]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = useCallback(async () => {
    setAppStatus('Waiting for Riot login...')
    const result = await loginWithRiot()
    setAppStatus('Ready')
    return result
  }, [loginWithRiot])

  const handleImport = useCallback(async () => {
    setAppStatus('Importing...')
    const result = await importAccount()
    setAppStatus('Ready')
    return result
  }, [importAccount])

  // Reset footer when launch status changes
  useEffect(() => {
    const vals = Object.values(statuses)
    const anyLaunching = vals.some(s => s.status === 'launching')
    const anyRunning = vals.some(s => s.status === 'running')
    if (anyRunning) setAppStatus('Valorant running')
    else if (!anyLaunching && (appStatus === 'Launching...' || appStatus === 'Valorant running')) setAppStatus('Ready')
  }, [statuses, appStatus])

  const handleLaunch = useCallback(async (accountId) => {
    setStatus(accountId, 'launching')
    setAppStatus('Launching...')
    const result = await launchValorant(accountId)
    if (!result.success) {
      setStatus(accountId, 'error', result.error)
      toast.error(result.error || 'Launch failed.')
      setAppStatus('Ready')
    }
  }, [launchValorant, setStatus, toast])

  const handleRemove = useCallback(async (accountId) => {
    const result = await removeAccount(accountId)
    if (result.success) {
      // Drop cached rank/session data + RR-tracking for the removed
      // account. Without this they pile up forever and re-imports of the
      // same puuid would briefly show a stale rank from before removal.
      setAccountRanks(prev => {
        if (!(accountId in prev)) return prev
        const next = { ...prev }; delete next[accountId]; return next
      })
      setAccountSessions(prev => {
        if (!(accountId in prev)) return prev
        const next = { ...prev }; delete next[accountId]; return next
      })
      delete lastSeenRrRef.current[accountId]
      toast.success('Account removed.')
    }
  }, [removeAccount, toast])

  const handleSetNickname = useCallback(async (accountId, nickname) => {
    const result = await setNickname(accountId, nickname)
    if (result.success) toast.success('Nickname updated.')
  }, [setNickname, toast])

  const handleReorder = useCallback(async (orderedIds) => {
    await reorderAccounts(orderedIds)
  }, [reorderAccounts])

  // If the currently-active tab gets disabled in settings, snap back to accounts.
  useEffect(() => {
    if (activeTab === 'store' && !features.store) setActiveTab('accounts')
    if (activeTab === 'match' && !features.matchInfo) setActiveTab('accounts')
  }, [features, activeTab])

  // Fetch rank badges + session stats for every account in PARALLEL — both
  // across accounts AND within each account (rank and session are
  // independent calls, no reason to serialize them). With 3 accounts this
  // drops cold-start UI time from ~12s sequential → ~2-3s. Cached in
  // component state so tab switches never re-fetch. Silently skips
  // accounts that fail (expired session, etc.).
  useEffect(() => {
    if (!accounts.length) { setAccountRanks({}); setAccountSessions({}); return }
    let cancelled = false
    const fetchOne = async (acc) => {
      const needRank = !accountRanks[acc.id]
      const needSession = !accountSessions[acc.id]
      if (!needRank && !needSession) return
      const [rankRes, sessionRes] = await Promise.allSettled([
        needRank ? window.electronAPI.getAccountRank(acc.id) : Promise.resolve(null),
        needSession ? window.electronAPI.getSessionStats(acc.id) : Promise.resolve(null),
      ])
      if (cancelled) return
      if (needRank && rankRes.status === 'fulfilled' && rankRes.value?.success && rankRes.value.rank) {
        setAccountRanks(prev => ({ ...prev, [acc.id]: rankRes.value.rank }))
      }
      if (needSession && sessionRes.status === 'fulfilled' && sessionRes.value?.success && sessionRes.value.session) {
        setAccountSessions(prev => ({ ...prev, [acc.id]: sessionRes.value.session }))
      }
    }
    Promise.all(accounts.map(fetchOne)).catch(() => {})
    return () => { cancelled = true }
  }, [accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track last-seen RR per account so we can detect post-match changes
  // and trigger a session-stats refresh (which is what backs the RR delta
  // arrow + W/L counts on the card). Stored in a ref so updates don't
  // trigger re-renders or recreate `refreshAccountRanks`.
  const lastSeenRrRef = useRef({})

  // Refresh all stored accounts in parallel. With the token cache in
  // place (see resolveLiveAuthTokens), each account is just 2 cheap MMR
  // calls — well under any rate limit even with several accounts.
  // Refreshing all of them (rather than only the "running" one) means
  // it works whether Valorant was launched via Nebula, externally, or
  // not at all. When rank.rr changes for an account, that's a signal
  // a match ended → trigger session stats refresh too so the RR delta
  // arrow and W/L counts catch up.
  const refreshAccountRanks = useCallback(async () => {
    if (!accounts.length) return
    await Promise.all(accounts.map(async (acc) => {
      try {
        const r = await window.electronAPI.getAccountRank(acc.id)
        if (!r.success || !r.rank) return
        setAccountRanks(prev => ({ ...prev, [acc.id]: r.rank }))
        const newRr = r.rank?.current?.rr
        const lastRr = lastSeenRrRef.current[acc.id]
        if (newRr != null && lastRr != null && newRr !== lastRr) {
          // RR moved — match likely just ended. Pull session stats so
          // the RR-delta arrow and W/L counts on the card update too.
          window.electronAPI.getSessionStats(acc.id).then(s => {
            if (s.success && s.session) setAccountSessions(prev => ({ ...prev, [acc.id]: s.session }))
          }).catch(() => {})
        }
        if (newRr != null) lastSeenRrRef.current[acc.id] = newRr
      } catch { /* silent */ }
    }))
  }, [accounts])

  // When auto-refresh is enabled and the user is viewing the accounts
  // tab, silently refresh the running account's rank/RR every 15s.
  // `refreshAccountRanks` is already scoped to the running account, so
  // this is at most one MMR call per tick.
  useEffect(() => {
    if (!autoRefresh || activeTab !== 'accounts') return
    const id = setInterval(refreshAccountRanks, 15_000)
    return () => clearInterval(id)
  }, [autoRefresh, activeTab, refreshAccountRanks])

  return (
    <div className="h-screen overflow-hidden p-4 flex flex-col">
      <div className="w-full flex flex-col flex-1 min-h-0 animate-fade-in">
        <Header
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenMenu={() => setMenuOpen(true)}
          activeTab={activeTab}
        />

        {/* key on activeTab remounts children so the fade-in replays on every tab switch */}
        <div key={activeTab} className="flex-1 min-h-0 flex flex-col gap-4 animate-fade-in">
          {activeTab === 'accounts' && (
            <>
              <div className="flex-1 min-h-0">
                <AccountList
                  accounts={accounts}
                  loading={loading}
                  statuses={statuses}
                  ranks={accountRanks}
                  sessions={accountSessions}
                  onLaunch={handleLaunch}
                  onRemove={handleRemove}
                  onCopySettings={setCopyTarget}
                  onSetNickname={setNicknameTarget}
                  onCheckSession={checkSession}
                  onReorder={handleReorder}
                />
              </div>
              <div className="shrink-0">
                <AddAccountSection onLogin={handleLogin} onImport={handleImport} />
              </div>
            </>
          )}
          {activeTab === 'store' && features.store && <StoreTab accounts={accounts} />}
          {activeTab === 'match' && features.matchInfo && <MatchInfoTab accounts={accounts} autoRefresh={autoRefresh} statuses={statuses} />}
          {activeTab === 'lookup' && <PlayerLookupTab accounts={accounts} />}
        </div>

        <Footer status={appStatus} />
        <SideMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          features={features}
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={refreshFeatures} />
        <CopySettingsDialog open={!!copyTarget} onOpenChange={(o) => { if (!o) setCopyTarget(null) }} targetAccount={copyTarget} accounts={accounts} />
        <NicknameDialog open={!!nicknameTarget} onOpenChange={(o) => { if (!o) setNicknameTarget(null) }} account={nicknameTarget} onSave={handleSetNickname} />
        <CloseDialog />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ThemeProvider>
  )
}
