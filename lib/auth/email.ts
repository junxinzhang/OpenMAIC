import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getAccountPool, ensureAuthSchema } from './db';
import { emailConfigured, publicOrigin } from './config';
import { digest, type AuthUser } from './session';
import { AuthError } from './http';
import { consumeLimit } from './limits';
export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError(400, '请输入有效邮箱。');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new AuthError(400, '请输入有效邮箱。');
  return email;
}
export async function sendEmailLogin(value: unknown): Promise<{ challengeId: string }> {
  if (!emailConfigured()) throw new AuthError(503, '邮箱登录暂未配置。');
  const email = normalizeEmail(value);
  await consumeLimit(`email:send:${email}`, 3, 900);
  await consumeLimit('email:send:global', 200, 3600);
  const challengeId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const code = randomInt(1000000).toString().padStart(6, '0');
  await getAccountPool().query(
    "INSERT INTO edu_auth_challenges(id,email,token_hash,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')",
    [challengeId, email, digest(token), digest(`${challengeId}:${code}`)],
  );
  const link = `${publicOrigin()}/api/v1/auth/login/email/verify?token=${encodeURIComponent(token)}`;
  try {
    const result = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY || process.env.AUTH_RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.AUTH_EMAIL_FROM,
        to: [email],
        subject: '登录 Zaokit Edu',
        text: `你的登录验证码：${code}\n也可以打开登录链接：${link}\n15 分钟内有效，只能使用一次。如果不是你本人操作，请忽略。`,
        html: `<h2>登录 Zaokit Edu</h2><p>验证码：<strong>${code}</strong></p><p><a href="${link}">继续登录 Zaokit Edu</a></p><p>15 分钟内有效，只能使用一次。如果不是你本人操作，请忽略。</p>`,
      }),
    });
    if (!result.ok) throw new Error('delivery failed');
  } catch {
    await getAccountPool().query('DELETE FROM edu_auth_challenges WHERE id=$1', [challengeId]);
    throw new AuthError(502, '邮件发送失败，请稍后重试。');
  }
  return { challengeId };
}
export async function consumeEmailLogin(input: {
  token?: unknown;
  challengeId?: unknown;
  email?: unknown;
  code?: unknown;
}): Promise<AuthUser> {
  await ensureAuthSchema();
  let tokenHash: string | null = null;
  let challengeId: string | null = null;
  let email: string | null = null;
  let codeHash: string | null = null;
  if (typeof input.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.token))
    tokenHash = digest(input.token);
  else {
    if (
      typeof input.challengeId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(input.challengeId) ||
      typeof input.code !== 'string' ||
      !/^\d{6}$/.test(input.code)
    )
      throw new AuthError(400, '验证码不正确或已过期。');
    challengeId = input.challengeId;
    email = normalizeEmail(input.email);
    codeHash = digest(`${challengeId}:${input.code}`);
  }
  await consumeLimit(`email:verify:${tokenHash ?? challengeId}`, 10, 900);
  const client = await getAccountPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{
      id: string;
      email: string;
      code_hash: string;
      attempts: number;
    }>(
      `SELECT id,email,code_hash,attempts FROM edu_auth_challenges WHERE ${tokenHash ? 'token_hash=$1' : 'id=$1 AND email=$2'} AND used_at IS NULL AND expires_at>now() FOR UPDATE`,
      tokenHash ? [tokenHash] : [challengeId, email],
    );
    const row = found.rows[0];
    if (!row || row.attempts >= 5) throw new AuthError(400, '验证码不正确或已过期。');
    if (!tokenHash && row.code_hash !== codeHash) {
      await client.query('UPDATE edu_auth_challenges SET attempts=attempts+1 WHERE id=$1', [
        row.id,
      ]);
      await client.query('COMMIT');
      throw new AuthError(400, '验证码不正确或已过期。');
    }
    await client.query('UPDATE edu_auth_challenges SET used_at=now() WHERE id=$1', [row.id]);
    const user = await client.query<AuthUser>(
      'INSERT INTO edu_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id,email,name',
      [randomUUID(), row.email],
    );
    await client.query('COMMIT');
    return user.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
