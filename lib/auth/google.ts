import { randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getAccountPool, ensureAuthSchema } from './db';
import { publicOrigin, googleConfigured, safeNext } from './config';
import { digest, cookie, readCookie, getRequestUser, type AuthUser } from './session';
import { AuthError } from './http';
import { normalizeEmail } from './email';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const STATE_COOKIE = 'edu_oauth';
export async function startGoogle(req: Request): Promise<Response> {
  if (!googleConfigured()) throw new AuthError(503, 'Google 登录暂未配置。');
  await ensureAuthSchema();
  const state = randomBytes(32).toString('base64url');
  const browser = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const user = await getRequestUser(req);
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  await getAccountPool().query(
    "INSERT INTO edu_auth_oauth(state_hash,browser_hash,verifier,nonce,next_path,link_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
    [digest(state), digest(browser), verifier, nonce, next, user?.id ?? null],
  );
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${publicOrigin()}/api/v1/auth/callback/google`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: Buffer.from(digest(verifier), 'hex').toString('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Set-Cookie': cookie(STATE_COOKIE, browser, 600),
      'Cache-Control': 'no-store',
    },
  });
}
export async function finishGoogle(req: Request): Promise<{ user: AuthUser; next: string }> {
  const params = new URL(req.url).searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const browser = readCookie(req.headers, STATE_COOKIE);
  if (!state || !code || !browser || state.length > 128 || code.length > 4096)
    throw new AuthError(400, 'Google 登录未完成，请重试。');
  await ensureAuthSchema();
  const result = await getAccountPool().query<{
    verifier: string;
    nonce: string;
    next_path: string;
    link_user_id: string | null;
  }>(
    'DELETE FROM edu_auth_oauth WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING verifier,nonce,next_path,link_user_id',
    [digest(state), digest(browser)],
  );
  const challenge = result.rows[0];
  if (!challenge) throw new AuthError(400, '登录请求已过期，请重试。');
  const exchanged = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      code_verifier: challenge.verifier,
      redirect_uri: `${publicOrigin()}/api/v1/auth/callback/google`,
      grant_type: 'authorization_code',
    }),
  });
  if (!exchanged.ok) throw new AuthError(400, 'Google 登录验证失败，请重试。');
  const tokens = (await exchanged.json()) as { id_token?: string };
  if (!tokens.id_token) throw new AuthError(400, 'Google 未返回有效身份。');
  let claims;
  try {
    claims = (
      await jwtVerify(tokens.id_token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: process.env.GOOGLE_CLIENT_ID,
        algorithms: ['RS256'],
      })
    ).payload;
  } catch {
    throw new AuthError(400, 'Google 身份验证失败。');
  }
  if (
    claims.nonce !== challenge.nonce ||
    claims.email_verified !== true ||
    !claims.sub ||
    (claims.azp && claims.azp !== process.env.GOOGLE_CLIENT_ID)
  )
    throw new AuthError(400, 'Google 身份验证失败。');
  const email = normalizeEmail(claims.email);
  const current = await getRequestUser(req);
  const client = await getAccountPool().connect();
  try {
    await client.query('BEGIN');
    // Serializes the first sign-in for one email across concurrent callbacks.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    const account = await client.query<AuthUser>(
      "SELECT u.id,u.email,u.name FROM edu_auth_accounts a JOIN edu_users u ON u.id=a.user_id WHERE a.provider='google' AND a.subject=$1",
      [claims.sub],
    );
    let user = account.rows[0];
    if (user && challenge.link_user_id && user.id !== challenge.link_user_id)
      throw new AuthError(409, '此 Google 账号已关联其他账户。');
    if (!user) {
      const existing = await client.query<AuthUser>(
        'SELECT id,email,name FROM edu_users WHERE email=$1',
        [email],
      );
      user = existing.rows[0];
      if (user && (current?.id !== user.id || challenge.link_user_id !== user.id))
        throw new AuthError(409, '此邮箱已有账户。请先用邮箱登录，再从账户页面关联 Google。');
      if (
        challenge.link_user_id &&
        (!current || current.id !== challenge.link_user_id || current.email !== email)
      )
        throw new AuthError(409, '请使用当前账户相同邮箱的 Google 账号。');
      if (!user) {
        const created = await client.query<AuthUser>(
          'INSERT INTO edu_users(id,email,name) VALUES($1,$2,$3) RETURNING id,email,name',
          [randomUUID(), email, typeof claims.name === 'string' ? claims.name.slice(0, 200) : null],
        );
        user = created.rows[0];
      }
      await client.query(
        "INSERT INTO edu_auth_accounts(provider,subject,user_id) VALUES('google',$1,$2)",
        [claims.sub, user.id],
      );
    }
    await client.query('COMMIT');
    return { user, next: safeNext(challenge.next_path) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export function clearGoogleCookie(): string {
  return cookie(STATE_COOKIE, '', 0);
}
