export function isAuthEnabled(): boolean {
  return ['true', '1'].includes(process.env.EDU_AUTH_ENABLED ?? '');
}
export function publicOrigin(): string {
  const value = process.env.EDU_PUBLIC_ORIGIN;
  if (!value) throw new Error('EDU_PUBLIC_ORIGIN is required');
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('Invalid EDU_PUBLIC_ORIGIN');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('Production authentication requires HTTPS');
  return url.origin;
}
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return '/';
  try {
    return new URL(value, 'https://edu.invalid').origin === 'https://edu.invalid' ? value : '/';
  } catch {
    return '/';
  }
}
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
export function emailConfigured(): boolean {
  return Boolean(
    (process.env.RESEND_API_KEY || process.env.AUTH_RESEND_KEY) && process.env.AUTH_EMAIL_FROM,
  );
}
