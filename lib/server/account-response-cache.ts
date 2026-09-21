import { isAuthEnabled } from '@/lib/auth/config';

/** User-scoped responses must override cache policies inherited from storage adapters. */
export function setAccountResponsePrivacy(headers: Headers): void {
  if (!isAuthEnabled()) return;
  headers.set('cache-control', 'private, no-store, max-age=0');
  headers.set('cdn-cache-control', 'private, no-store');
  headers.set('vercel-cdn-cache-control', 'private, no-store');
  headers.set('surrogate-control', 'no-store');
  headers.set('expires', '0');
  const vary = new Set(
    (headers.get('vary') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!vary.has('*')) {
    vary.add('Cookie');
    vary.add('Authorization');
  }
  headers.set('vary', [...vary].join(', '));
}

export function withAccountResponsePrivacy(response: Response): Response {
  if (!isAuthEnabled()) return response;
  // Constructing from the existing stream also supports immutable fetch headers.
  const headers = new Headers(response.headers);
  setAccountResponsePrivacy(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
