import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastVariant = 'info' | 'success' | 'error';

interface ToastRecord {
  id: number;
  variant: ToastVariant;
  title: string;
  body?: string;
}

export interface ToastApi {
  info: (title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Transient feedback (spec 12): success, non-critical failure, copy actions and
 * server start/stop. Screen-level failures stay inline in the page.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const push = useCallback((variant: ToastVariant, title: string, body?: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { id, variant, title, body }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, variant === 'error' ? 9000 : 4500);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      info: (title, body) => push('info', title, body),
      success: (title, body) => push('success', title, body),
      error: (title, body) => push('error', title, body),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.variant}`}>
            <div className="toast__title">{toast.title}</div>
            {toast.body ? <div className="toast__body">{toast.body}</div> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
