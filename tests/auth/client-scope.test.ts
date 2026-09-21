import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountStorageName, setAccountScope } from '@/lib/auth/client-scope';
describe('account cache isolation without deleting older data', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses separate persistent names for each account and keeps legacy names intact', () => {
    const values = new Map<string, string>();
    const local = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      localStorage: { setItem: (key: string, value: string) => local.set(key, value) },
    });
    expect(accountStorageName('maic-documents')).toBe('maic-documents');
    setAccountScope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const first = accountStorageName('maic-documents');
    setAccountScope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(accountStorageName('maic-documents')).not.toBe(first);
    setAccountScope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(accountStorageName('maic-documents')).toBe(first);
    setAccountScope('guest');
    expect(accountStorageName('maic-documents')).toBe('maic-documents:edu:guest');
  });
});

describe('account-scoped browser preference storage', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('never hydrates another account settings or deletes their saved values', async () => {
    const { BrowserKVStore } = await import('@openmaic/storage');
    const data = new Map<string, string>();
    const scopes = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
    };
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => scopes.get(key) ?? null,
        setItem: (key: string, value: string) => scopes.set(key, value),
      },
      localStorage: storage,
    });
    const legacy = new BrowserKVStore({ storage });
    await legacy.set('settings', { privateValue: 'legacy' });
    setAccountScope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const first = new BrowserKVStore({ storage, namespace: accountStorageName('maic') });
    expect(await first.get('settings')).toBeNull();
    await first.set('settings', { privateValue: 'first' });
    setAccountScope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const second = new BrowserKVStore({ storage, namespace: accountStorageName('maic') });
    expect(await second.get('settings')).toBeNull();
    await second.set('settings', { privateValue: 'second' });
    expect(await first.get('settings')).toEqual({ privateValue: 'first' });
    expect(await legacy.get('settings')).toEqual({ privateValue: 'legacy' });
  });
});
