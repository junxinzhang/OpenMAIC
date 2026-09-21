import { afterEach, describe, it, expect, vi } from 'vitest';
const calls = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  getRequestUser: async () => ({ id: 'alice', email: 'alice@example.test' }),
}));
vi.mock('@/lib/billing/store', () => ({
  reserveCredits: calls.reserve,
  settleCredits: calls.settle,
  releaseCredits: calls.release,
}));
import { withBillableRequest } from '@/lib/billing/guard';
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.EDU_BILLING_ENABLED;
});
describe('billable response lifecycle', () => {
  it('releases an explicit SSE business failure despite HTTP 200', async () => {
    process.env.EDU_BILLING_ENABLED = 'true';
    const response = await withBillableRequest(
      new Request('https://edu.example/api'),
      'generate',
      async () =>
        new Response('event: error\ndata: {"error":"failed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    await response.text();
    expect(calls.release).toHaveBeenCalledOnce();
    expect(calls.settle).not.toHaveBeenCalled();
  });
  it('keeps unknown interrupted streams reserved', async () => {
    process.env.EDU_BILLING_ENABLED = 'true';
    const response = await withBillableRequest(
      new Request('https://edu.example/api'),
      'generate',
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(new Error('network lost'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    await expect(response.text()).rejects.toThrow();
    expect(calls.reserve).toHaveBeenCalledOnce();
    expect(calls.release).not.toHaveBeenCalled();
    expect(calls.settle).not.toHaveBeenCalled();
  });
  it('settles a complete successful stream', async () => {
    process.env.EDU_BILLING_ENABLED = 'true';
    const response = await withBillableRequest(
      new Request('https://edu.example/api'),
      'generate',
      async () =>
        new Response('data: {"ok":true}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    await response.text();
    expect(calls.settle).toHaveBeenCalledOnce();
  });
  it('does not execute duplicate requests', async () => {
    process.env.EDU_BILLING_ENABLED = 'true';
    calls.reserve.mockRejectedValueOnce(new Error('duplicate'));
    const handler = vi.fn();
    const response = await withBillableRequest(
      new Request('https://edu.example/api'),
      'generate',
      handler,
    );
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
