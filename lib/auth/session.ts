import { createHash, randomBytes } from 'node:crypto';
import { getAccountPool, ensureAuthSchema } from './db';
import { isAuthEnabled, publicOrigin } from './config';
export type AuthUser = { id: string; email: string; name: string | null };
export const SESSION_COOKIE = 'edu_session';
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function readCookie(headers: Headers, key: string): string | undefined {
  const value = headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${key}=`))
    ?.slice(key.length + 1);
  try {
    return value ? decodeURIComponent(value) : undefined;
  } catch {
    return undefined;
  }
}
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${publicOrigin().startsWith('https:') ? '; Secure' : ''}`;
}
export async function getRequestUser(req: Pick<Request, 'headers'>): Promise<AuthUser | null> {
  if (!isAuthEnabled()) return null;
  const token = readCookie(req.headers, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  await ensureAuthSchema();
  const result = await getAccountPool().query<AuthUser>(
    'SELECT u.id,u.email,u.name FROM edu_auth_sessions s JOIN edu_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [digest(token)],
  );
  return result.rows[0] ?? null;
}
export async function createSession(userId: string, headers: Headers): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await getAccountPool().query(
    "INSERT INTO edu_auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [digest(token), userId],
  );
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, token, 30 * 86400));
}
export async function logout(req: Request, headers: Headers): Promise<void> {
  const token = readCookie(req.headers, SESSION_COOKIE);
  if (token) {
    await ensureAuthSchema();
    await getAccountPool().query('DELETE FROM edu_auth_sessions WHERE token_hash=$1', [
      digest(token),
    ]);
  }
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
}
