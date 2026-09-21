import { randomUUID } from 'node:crypto';
import { getRequestUser } from '@/lib/auth/session';
import { consumeLimit } from '@/lib/auth/limits';
import { AuthError } from '@/lib/auth/http';
import { BillingError, isBillingEnabled } from './config';
import { reserveCredits, releaseCredits, settleCredits } from './store';
import { withBillingUsage } from './usage-context';
import { isCoworkBilling } from './policy';
export { reserveCredits, releaseCredits, settleCredits };
export function billingErrorResponse(error: unknown) {
  if (error instanceof BillingError)
    return Response.json(
      {
        error: isCoworkBilling() ? error.message : error.code,
        code: error.code,
        message: error.message,
        upgrade: error.status === 402,
      },
      {
        status: error.status,
        headers: {
          'Cache-Control': 'private, no-store',
          ...(error.status === 429 ? { 'Retry-After': '30' } : {}),
        },
      },
    );
  console.error('[billing] request failed', error instanceof Error ? error.name : 'unknown');
  return Response.json(
    { error: 'billing_unavailable', message: '账户服务暂时不可用，请稍后重试' },
    { status: 503 },
  );
}
/** Synchronous response/stream operations only. Background jobs must settle from their worker. */
export async function withBillableRequest(
  req: Request,
  action: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!isBillingEnabled()) return handler();
  const user = await getRequestUser(req);
  if (!user) return Response.json({ error: 'unauthorized', message: '请先登录' }, { status: 401 });
  // Configuration checks are control-plane probes, not billable generation.
  // Keep them authenticated and bounded without trapping an allowance for absent usage.
  const checks = new Set([
    '/api/provider/probe-models',
    '/api/verify-model',
    '/api/verify-image-provider',
    '/api/verify-video-provider',
    '/api/verify-pdf-provider',
  ]);
  if (isCoworkBilling() && checks.has(new URL(req.url).pathname)) {
    try {
      await consumeLimit('edu-config-check:' + user.id, 30, 3600);
    } catch (error) {
      return billingErrorResponse(
        error instanceof AuthError
          ? new BillingError('verification_rate_limit', error.message, error.status)
          : error,
      );
    }
    return handler();
  }
  const key = req.headers.get('idempotency-key');
  if (key && !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))
    return Response.json({ error: 'invalid_idempotency_key' }, { status: 400 });
  const operationId = `${user.id}:${key || randomUUID()}`;
  try {
    await reserveCredits(user.id, operationId, action);
  } catch (error) {
    return billingErrorResponse(error);
  }
  let handlerReturned = false;
  try {
    const response = await (isCoworkBilling()
      ? withBillingUsage(user.id, operationId, handler)
      : handler());
    handlerReturned = true;
    if (!response.ok) {
      await releaseCredits(user.id, operationId);
      return response;
    }
    if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failed = false;
      const inspect = (chunk: Uint8Array) => {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        if (buffer.length > 1048576) buffer = buffer.slice(-65536);
        for (const frame of frames) {
          if (/^event:\s*error$/m.test(frame)) failed = true;
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            try {
              const value = JSON.parse(line.slice(5));
              if (value.error || value.type === 'error' || value.status === 'failed') failed = true;
            } catch {}
          }
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              inspect(new TextEncoder().encode('\n\n'));
              if (failed) await releaseCredits(user.id, operationId);
              else await settleCredits(user.id, operationId);
              controller.close();
            } else {
              inspect(item.value);
              controller.enqueue(item.value);
            }
          } catch (error) {
            if (isCoworkBilling()) {
              await reader.cancel(error).catch(() => undefined);
              await settleCredits(user.id, operationId, 'interrupted').catch(() => undefined);
            }
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          if (isCoworkBilling())
            await settleCredits(user.id, operationId, 'interrupted').catch(() => undefined);
        },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    await settleCredits(user.id, operationId);
    return response;
  } catch (error) {
    if (isCoworkBilling() && !handlerReturned)
      await releaseCredits(user.id, operationId).catch(() => undefined);
    // A thrown handler/settlement error is not proof no upstream work ran.
    // Preserve the reservation until execution evidence can be reconciled.
    return billingErrorResponse(error);
  }
}
