/** A local cache partition, never an authorization credential. */
export const ACCOUNT_SCOPE_KEY = 'edu.account.scope';
export const ACCOUNT_CHANGE_KEY = 'edu.account.changed';
export function accountStorageName(base: string): string {
  if (typeof window === 'undefined') return base;
  const scope = window.sessionStorage?.getItem(ACCOUNT_SCOPE_KEY) ?? null;
  return scope && /^(guest|[0-9a-f-]{36})$/.test(scope) ? `${base}:edu:${scope}` : base;
}
export function currentAccountScope(): string | null {
  return window.sessionStorage?.getItem(ACCOUNT_SCOPE_KEY) ?? null;
}
export function setAccountScope(scope: string): void {
  if (!/^(guest|[0-9a-f-]{36})$/.test(scope)) throw new Error('Invalid account scope');
  window.sessionStorage.setItem(ACCOUNT_SCOPE_KEY, scope);
  window.localStorage.setItem(ACCOUNT_CHANGE_KEY, scope);
}
/** Client-side addressing only; the server independently verifies the session. */
export function accountLearnerKey(): string | null {
  if (typeof window === 'undefined') return null;
  const scope = currentAccountScope();
  return scope && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope)
    ? `user:${scope}`
    : null;
}
