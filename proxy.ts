import { NextRequest, NextResponse } from 'next/server';

import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { verifyAccessTokenEdge } from '@/lib/server/access-token-edge';
import { isAuthEnabled } from '@/lib/auth/config';
import { getRequestUser } from '@/lib/auth/session';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Authentication callbacks and signed payment notifications must never be
  // intercepted by the legacy shared access-code prompt.
  if (
    pathname.startsWith('/api/v1/auth/') ||
    pathname === '/api/webhooks/stripe' ||
    pathname === '/api/health' ||
    pathname === '/login'
  ) {
    return NextResponse.next();
  }

  if (isAuthEnabled()) {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    // These handlers perform their own owner/publication checks. This merely
    // allows a guest to reach the check, never grants access to the document.
    const publicRead =
      isRead &&
      (/^\/classroom\/[^/]+$/.test(pathname) ||
        /^\/api\/stages\/[^/]+(?:\/(?:scenes|manifest|freshness))?$/.test(pathname) ||
        /^\/api\/persistence\/(?:documents|assets)\//.test(pathname) ||
        /^\/api\/stage-meta\/[^/]+$/.test(pathname) ||
        pathname === '/api/classroom' ||
        pathname.startsWith('/api/classroom-media/') ||
        pathname === '/api/access-code/status');
    if (!isRead) {
      const origin = request.headers.get('origin');
      const expected = process.env.EDU_PUBLIC_ORIGIN || request.nextUrl.origin;
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (origin && origin !== new URL(expected).origin)
      ) {
        return NextResponse.json({ error: '请求来源不受信任。' }, { status: 403 });
      }
    }
    if (publicRead) return NextResponse.next();
    try {
      const user = await getRequestUser(request);
      if (user) return NextResponse.next();
    } catch {
      return NextResponse.json({ error: '账户服务暂时不可用，请稍后重试。' }, { status: 503 });
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { success: false, error: '请先登录。', errorCode: 'AUTH_REQUIRED' },
        { status: 401 },
      );
    }
    const login = new URL('/login', request.url);
    login.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyAccessTokenEdge(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
