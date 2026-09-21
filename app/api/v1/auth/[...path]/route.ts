import {
  isAuthEnabled,
  googleConfigured,
  emailConfigured,
  safeNext,
  publicOrigin,
} from '@/lib/auth/config';
import { getRequestUser, createSession, logout } from '@/lib/auth/session';
import { AuthError, verifyOrigin, readBody } from '@/lib/auth/http';
import { sendEmailLogin, consumeEmailLogin } from '@/lib/auth/email';
import { startGoogle, finishGoogle, clearGoogleCookie } from '@/lib/auth/google';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function json(value: unknown, status = 200, headers = new Headers()): Response {
  headers.set('Cache-Control', 'no-store');
  return Response.json(value, { status, headers });
}
async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace('/api/v1/auth/', '');
  if (path === 'providers' && req.method === 'GET')
    return json({ enabled: isAuthEnabled(), google: googleConfigured(), email: emailConfigured() });
  if (path === 'me' && req.method === 'GET') return json({ user: await getRequestUser(req) });
  if (!isAuthEnabled()) return json({ error: '账号登录尚未启用。' }, 404);
  if (req.method === 'POST') verifyOrigin(req);
  if (path === 'login/google' && req.method === 'GET') return startGoogle(req);
  if (path === 'callback/google' && req.method === 'GET') {
    try {
      const { user, next } = await finishGoogle(req);
      const headers = new Headers({
        Location: `${publicOrigin()}${next}`,
        'Cache-Control': 'no-store',
      });
      await createSession(user.id, headers);
      headers.append('Set-Cookie', clearGoogleCookie());
      return new Response(null, { status: 302, headers });
    } catch (error) {
      const message =
        error instanceof AuthError ? error.message : 'Google 登录暂时无法完成，请重试。';
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${publicOrigin()}/login?error=${encodeURIComponent(message)}`,
          'Set-Cookie': clearGoogleCookie(),
          'Cache-Control': 'no-store',
        },
      });
    }
  }
  if (path === 'login/email' && req.method === 'POST') {
    const body = await readBody(req);
    return json(await sendEmailLogin(body.email));
  }
  if (path === 'login/email/verify' && req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AuthError(400, '链接不正确或已过期。');
    // A scanner opening the email cannot consume the token; the user confirms in the login page.
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${publicOrigin()}/login#token=${encodeURIComponent(token)}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
  if (path === 'login/email/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await consumeEmailLogin(body);
    const headers = new Headers();
    await createSession(user.id, headers);
    return json(
      { user, next: safeNext(typeof body.next === 'string' ? body.next : null) },
      200,
      headers,
    );
  }
  if (path === 'logout' && req.method === 'POST') {
    const headers = new Headers();
    await logout(req, headers);
    return json({ ok: true }, 200, headers);
  }
  return json({ error: 'Not found' }, 404);
}
async function route(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    console.error('[auth] request failed', error instanceof Error ? error.name : 'unknown');
    return json({ error: '登录服务暂时不可用，请稍后重试。' }, 503);
  }
}
export const GET = route;
export const POST = route;
