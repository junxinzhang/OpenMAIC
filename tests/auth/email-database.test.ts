import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  return { db: new PGlite() };
});
vi.mock('pg', () => ({
  Pool: class {
    async query(sql: string, params: unknown[] = []) {
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
import { consumeEmailLogin, sendEmailLogin } from '@/lib/auth/email';
import { createSession, getRequestUser, logout } from '@/lib/auth/session';

describe('email sign-in against a real PostgreSQL-compatible database', () => {
  let sent: { text: string };
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://test/edu');
    await ensureAuthSchema();
  });
  beforeEach(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://test/edu');
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    vi.stubEnv('EDU_PUBLIC_ORIGIN', 'https://edu.example.com');
    vi.stubEnv('RESEND_API_KEY', 'test-only');
    vi.stubEnv('AUTH_EMAIL_FROM', 'Edu <noreply@example.com>');
    await fixture.db.exec(
      'TRUNCATE edu_auth_oauth,edu_auth_sessions,edu_auth_accounts,edu_auth_challenges,edu_auth_limits,edu_users CASCADE',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        sent = JSON.parse(init.body);
        return new Response('{}', { status: 200 });
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fixture.db.close();
  });
  it('issues a session for the verified mailbox and revokes it on logout', async () => {
    const { challengeId } = await sendEmailLogin('Test@example.com');
    const code = sent.text.match(/验证码：(\d{6})/)![1];
    const user = await consumeEmailLogin({ challengeId, email: 'test@example.com', code });
    expect(user.email).toBe('test@example.com');
    const headers = new Headers();
    await createSession(user.id, headers);
    const req = new Request('https://edu.example.com', {
      headers: { cookie: headers.get('set-cookie')!.split(';')[0] },
    });
    expect((await getRequestUser(req))?.id).toBe(user.id);
    await logout(req, new Headers());
    expect(await getRequestUser(req)).toBeNull();
    await expect(
      consumeEmailLogin({ challengeId, email: 'test@example.com', code }),
    ).rejects.toThrow();
  });
  it('binds a code to its mailbox and locks the challenge after five wrong attempts', async () => {
    const { challengeId } = await sendEmailLogin('test@example.com');
    const code = sent.text.match(/验证码：(\d{6})/)![1];
    await expect(
      consumeEmailLogin({ challengeId, email: 'other@example.com', code }),
    ).rejects.toThrow();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await expect(
        consumeEmailLogin({ challengeId, email: 'test@example.com', code: wrong }),
      ).rejects.toThrow();
    await expect(
      consumeEmailLogin({ challengeId, email: 'test@example.com', code }),
    ).rejects.toThrow();
  });
  it('rejects an expired email link and reuses the account after a fresh login', async () => {
    const first = await sendEmailLogin('test@example.com');
    const token = new URL(sent.text.match(/https:\/\/\S+/)![0]).searchParams.get('token')!;
    await getAccountPool().query(
      "UPDATE edu_auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
      [first.challengeId],
    );
    await expect(consumeEmailLogin({ token })).rejects.toThrow();
    const second = await sendEmailLogin('test@example.com');
    const code = sent.text.match(/验证码：(\d{6})/)![1];
    const user = await consumeEmailLogin({
      challengeId: second.challengeId,
      email: 'test@example.com',
      code,
    });
    const third = await sendEmailLogin('test@example.com');
    const nextCode = sent.text.match(/验证码：(\d{6})/)![1];
    expect(
      (
        await consumeEmailLogin({
          challengeId: third.challengeId,
          email: 'test@example.com',
          code: nextCode,
        })
      ).id,
    ).toBe(user.id);
    await expect(sendEmailLogin('test@example.com')).rejects.toThrow('尝试过于频繁');
  });
});
