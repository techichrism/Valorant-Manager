import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'

const ThemeContext = createContext({ theme: 'system', setTheme: () => {} })

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('system')
  const themeRef = useRef(theme)

  const applyTheme = useCallback((t) => {
    setThemeState(t)
    themeRef.current = t
    const root = document.documentElement
    root.classList.remove('dark')
    if (t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.classList.add('dark')
    }
  }, [])

  useEffect(() => {
    window.electronAPI.getSettings().then(s => applyTheme(s.theme || 'system')).catch(() => {})
    window.electronAPI.onApplyTheme(applyTheme)

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => { if (themeRef.current === 'system') applyTheme('system') }
    mediaQuery.addEventListener('change', handler)

    return () => {
      window.electronAPI.removeApplyThemeListener()
      mediaQuery.removeEventListener('change', handler)
    }
  }, [applyTheme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme: applyTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
