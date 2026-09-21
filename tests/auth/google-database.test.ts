import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
const fixture = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(pair.publicKey);
  return {
    db: new PGlite(),
    jose,
    pair,
    jwks: jose.createLocalJWKSet({ keys: [{ ...jwk, kid: 'test' }] }),
  };
});
vi.mock('jose', () => ({ ...fixture.jose, createRemoteJWKSet: () => fixture.jwks }));
vi.mock('pg', () => ({
  Pool: class {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (!params.length && sql.includes('CREATE TABLE')) {
        await fixture.db.exec(sql);
        return { rows: [] };
      }
      return fixture.db.query(sql, params);
    }
    async connect() {
      return { query: this.query.bind(this), release: () => {} };
    }
  },
}));
import { ensureAuthSchema, getAccountPool } from '@/lib/auth/db';
import { startGoogle, finishGoogle } from '@/lib/auth/google';
import { createSession } from '@/lib/auth/session';
describe('Google identity and account linking', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://test/edu');
    await ensureAuthSchema();
  });
  beforeEach(async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    vi.stubEnv('EDU_PUBLIC_ORIGIN', 'https://edu.example.com');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
    await fixture.db.exec(
      'TRUNCATE edu_auth_oauth,edu_auth_sessions,edu_auth_accounts,edu_auth_challenges,edu_auth_limits,edu_users CASCADE',
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fixture.db.close();
  });
  async function flow(
    options: { verified?: boolean; issuer?: string; cookie?: string; badState?: boolean } = {},
  ) {
    const started = await startGoogle(
      new Request('https://edu.example.com/api/v1/auth/login/google?next=/account', {
        headers: options.cookie ? { cookie: options.cookie } : {},
      }),
    );
    const target = new URL(started.headers.get('location')!);
    const cookie =
      started.headers.get('set-cookie')!.split(';')[0] +
      (options.cookie ? `; ${options.cookie}` : '');
    const token = await new fixture.jose.SignJWT({
      email: 'test@example.com',
      email_verified: options.verified ?? true,
      nonce: target.searchParams.get('nonce'),
      name: 'Test',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(options.issuer ?? 'https://accounts.google.com')
      .setAudience('test-client')
      .setSubject('google-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(fixture.pair.privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id_token: token })),
    );
    return new Request(
      `https://edu.example.com/api/v1/auth/callback/google?state=${options.badState ? 'wrong' : target.searchParams.get('state')}&code=test-code`,
      { headers: { cookie } },
    );
  }
  it('verifies the signed Google identity and consumes browser-bound state once', async () => {
    const req = await flow();
    const result = await finishGoogle(req);
    expect(result.user.email).toBe('test@example.com');
    expect(result.next).toBe('/account');
    await expect(finishGoogle(req)).rejects.toThrow('过期');
  });
  it('rejects unverified email, wrong issuer, and unrelated browser state', async () => {
    await expect(finishGoogle(await flow({ verified: false }))).rejects.toThrow('身份验证失败');
    await expect(finishGoogle(await flow({ issuer: 'https://evil.example' }))).rejects.toThrow(
      '身份验证失败',
    );
    await expect(finishGoogle(await flow({ badState: true }))).rejects.toThrow('过期');
  });
  it('requires an existing email account session before adding Google sign-in', async () => {
    const id = 'a92f584c-4817-4d8e-bcfb-21b3b4d41933';
    await getAccountPool().query('INSERT INTO edu_users(id,email) VALUES($1,$2)', [
      id,
      'test@example.com',
    ]);
    await expect(finishGoogle(await flow())).rejects.toThrow('先用邮箱登录');
    const headers = new Headers();
    await createSession(id, headers);
    const result = await finishGoogle(
      await flow({ cookie: headers.get('set-cookie')!.split(';')[0] }),
    );
    expect(result.user.id).toBe(id);
  });
});
