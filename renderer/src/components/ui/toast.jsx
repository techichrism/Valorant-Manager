import { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

const ToastContext = createContext(null)

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const styles = {
  success: 'border-purple-200 bg-purple-50 text-purple-800 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200',
  info: 'border-border bg-card text-card-foreground',
}

function Toast({ toast, onDismiss }) {
  const [exiting, setExiting] = useState(false)
  const Icon = icons[toast.type] || icons.info

  const close = useCallback(() => {
    setExiting(true)
    setTimeout(() => onDismiss(toast.id), 200)
  }, [onDismiss, toast.id])

  useEffect(() => {
    // duration of 0 means persistent (no auto-dismiss)
    if (toast.duration === 0) return
    const timer = setTimeout(close, toast.duration || 3500)
    return () => clearTimeout(timer)
  }, [toast, close])

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-lg text-sm transition-all duration-200',
        exiting ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0 animate-slide-in',
        styles[toast.type] || styles.info
      )}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <p className="flex-1 leading-snug">{toast.message}</p>
      {toast.action && (
        <button
          onClick={() => { toast.action.onClick(); close() }}
          className="shrink-0 px-2 py-0.5 rounded text-xs font-medium bg-current/10 hover:bg-current/20 transition-colors"
        >
          {toast.action.label}
        </button>
      )}
      <button onClick={close} className="shrink-0 opacity-50 hover:opacity-100 transition-opacity">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((message, type = 'info', options = {}) => {
    const id = Date.now() + Math.random()
    const { duration, action } = typeof options === 'number' ? { duration: options } : options
    setToasts(prev => [...prev.slice(-2), { id, message, type, duration, action }])
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useMemo(() => ({
    success: (msg, opts) => addToast(msg, 'success', opts),
    error: (msg, opts) => addToast(msg, 'error', opts ?? 5000),
    info: (msg, opts) => addToast(msg, 'info', opts),
  }), [addToast])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 max-w-[calc(100%-2rem)] pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto max-w-full">
            <Toast toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
