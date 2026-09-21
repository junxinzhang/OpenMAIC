import { withAccountResponsePrivacy } from '@/lib/server/account-response-cache';
import { resolveAuthenticatedRequestOwnerId } from './owner';

/**
 * Resolve the account identity (or standalone anonymous owner) and run a handler with its response
 * headers.
 *
 * The Set-Cookie minted by resolveAuthenticatedRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  const ownerId = await resolveAuthenticatedRequestOwnerId(req, responseHeaders);
  if (!ownerId)
    return withAccountResponsePrivacy(
      Response.json({ error: 'Authentication required' }, { status: 401 }),
    );
  try {
    return withAccountResponsePrivacy(await handler(ownerId, responseHeaders));
  } catch (error) {
    console.error('[agent-runtime] request failed under the resolved owner', error);
    return withAccountResponsePrivacy(
      new Response('Internal Server Error', { status: 500, headers: responseHeaders }),
    );
  }
}
