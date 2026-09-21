'use client';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ACCOUNT_SCOPE_KEY,
  ACCOUNT_CHANGE_KEY,
  currentAccountScope,
  setAccountScope,
} from '@/lib/auth/client-scope';
/** Mount all cache-using children only after their account partition is known. */
export function AccountSessionBoundary({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(!enabled);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) {
      if (currentAccountScope()) {
        window.sessionStorage.removeItem(ACCOUNT_SCOPE_KEY);
        window.location.reload();
      }
      return;
    }
    let disposed = false;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/v1/auth/me', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (disposed) return;
        const scope = result.user?.id ?? 'guest';
        if (currentAccountScope() !== scope) {
          setReady(false);
          setAccountScope(scope);
          window.location.reload();
          return;
        }
        setReady(true);
        setError(false);
      } catch {
        if (!disposed) {
          setReady(false);
          setError(true);
        }
      } finally {
        checking = false;
      }
    }
    function visibility() {
      if (document.visibilityState === 'visible') {
        void check();
      }
    }
    function changed(event: StorageEvent) {
      if (event.key === ACCOUNT_CHANGE_KEY && event.newValue !== currentAccountScope()) {
        setReady(false);
        window.location.reload();
      }
    }
    void check();
    window.addEventListener('focus', visibility);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', changed);
    const timer = window.setInterval(() => void check(), 60000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', visibility);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', changed);
    };
  }, [enabled]);
  if (!enabled || ready) return children;
  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-center" role="status">
      <div>
        <p>{error ? '暂时无法确认登录状态，请重试。' : '正在确认登录状态…'}</p>
        {error && (
          <button
            className="mt-4 rounded border px-4 py-2"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        )}
      </div>
    </main>
  );
}
