import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthEnabled, publicOrigin, safeNext } from '@/lib/auth/config';
import { verifyOrigin } from '@/lib/auth/http';
import { normalizeEmail } from '@/lib/auth/email';
import { cookie, readCookie } from '@/lib/auth/session';

describe('authentication request boundaries', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('EDU_PUBLIC_ORIGIN', 'https://edu.example.com');
  });
  it('requires an explicit authentication opt-in', () => {
    vi.stubEnv('EDU_AUTH_ENABLED', '');
    expect(isAuthEnabled()).toBe(false);
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    expect(isAuthEnabled()).toBe(true);
  });
  it('rejects external redirects and preserves local destinations', () => {
    for (const path of ['//evil.com', 'https://evil.com', '/\\evil.com', '/\n/evil.com'])
      expect(safeNext(path)).toBe('/');
    expect(safeNext('/account?tab=billing')).toBe('/account?tab=billing');
  });
  it('requires the configured origin for login and logout mutations', () => {
    expect(() =>
      verifyOrigin(
        new Request('https://edu.example.com/api', { headers: { origin: 'https://evil.com' } }),
      ),
    ).toThrow();
    expect(() => verifyOrigin(new Request('https://edu.example.com/api'))).toThrow();
    expect(() =>
      verifyOrigin(
        new Request('https://edu.example.com/api', {
          headers: { origin: 'https://edu.example.com' },
        }),
      ),
    ).not.toThrow();
  });
  it('requires HTTPS in production and never accepts a path as site origin', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EDU_PUBLIC_ORIGIN', 'http://edu.example.com');
    expect(publicOrigin).toThrow();
    vi.stubEnv('EDU_PUBLIC_ORIGIN', 'https://edu.example.com/untrusted');
    expect(publicOrigin).toThrow();
  });
  it('normalizes addresses and rejects malformed input', () => {
    expect(normalizeEmail(' Test@Example.COM ')).toBe('test@example.com');
    for (const value of ['a\nb@example.com', 'not-an-email', '<a>@example.com', null])
      expect(() => normalizeEmail(value)).toThrow();
  });
  it('protects cookies and treats invalid encoding as absent', () => {
    expect(cookie('edu_session', 'secret', 60)).toContain(
      'HttpOnly; SameSite=Lax; Max-Age=60; Secure',
    );
    expect(readCookie(new Headers({ cookie: 'edu_session=%XX' }), 'edu_session')).toBeUndefined();
  });
});
