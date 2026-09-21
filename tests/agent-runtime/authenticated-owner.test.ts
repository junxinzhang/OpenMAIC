import { afterEach, describe, expect, it, vi } from 'vitest';
const getRequestUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getRequestUser }));
import { resolveAuthenticatedRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('account owner boundary', () => {
  it('ignores an anonymous identity when an account is authenticated', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    getRequestUser.mockResolvedValue({ id: 'account-one' });
    const headers = new Headers();
    const req = new Request('http://localhost/api/agent/sessions', {
      headers: {
        cookie: 'anonymous_id=11111111-1111-4111-8111-111111111111',
      },
    });
    expect(await resolveAuthenticatedRequestOwnerId(req, headers)).toBe('user:account-one');
    expect(headers.has('set-cookie')).toBe(false);
  });
  it('refuses anonymous private operations without executing the handler', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    getRequestUser.mockResolvedValue(null);
    const handler = vi.fn();
    const response = await withRequestOwnerId(
      new Request('http://localhost/api/agent/sessions'),
      handler,
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
  it('allows only a read-only public principal at public document entry points', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    getRequestUser.mockResolvedValue(null);
    const url = 'http://localhost/api/persistence/documents/example';
    expect(await resolveAuthenticatedRequestOwnerId(new Request(url), new Headers())).toBe(
      'public:visitor',
    );
    expect(
      await resolveAuthenticatedRequestOwnerId(new Request(url, { method: 'PUT' }), new Headers()),
    ).toBeNull();
  });
  it('overrides public storage caching on private responses without losing body or headers', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    getRequestUser.mockResolvedValue({ id: 'account-one' });
    const response = await withRequestOwnerId(
      new Request('http://localhost/api/persistence/assets/asset'),
      async () =>
        new Response('private bytes', {
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'CDN-Cache-Control': 'public',
            Vary: 'Accept-Encoding',
            'Content-Type': 'image/png',
          },
        }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('cdn-cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.text()).toBe('private bytes');
  });
  it('does not cache authentication failures or change standalone cache policy', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    getRequestUser.mockResolvedValue(null);
    const failed = await withRequestOwnerId(
      new Request('http://localhost/api/agent/sessions'),
      vi.fn(),
    );
    expect(failed.headers.get('cache-control')).toContain('no-store');
    vi.stubEnv('EDU_AUTH_ENABLED', 'false');
    const legacy = await withRequestOwnerId(
      new Request('http://localhost/api/persistence/assets/asset'),
      async () => new Response('legacy', { headers: { 'Cache-Control': 'public, immutable' } }),
    );
    expect(legacy.headers.get('cache-control')).toBe('public, immutable');
  });
  it('retains the anonymous standalone mode when accounts are disabled', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'false');
    expect(
      await resolveAuthenticatedRequestOwnerId(
        new Request('http://localhost/api/agent/sessions'),
        new Headers(),
      ),
    ).toMatch(/^anon:/);
    expect(getRequestUser).not.toHaveBeenCalled();
  });
});
