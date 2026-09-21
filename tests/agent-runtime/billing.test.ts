import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/lib/billing/store', () => ({
  billingPool: async () => ({ query: mocks.query }),
  ensureRunReservation: mocks.reserve,
  settleCredits: mocks.settle,
  releaseCredits: mocks.release,
}));
import { createAgentBilling } from '@/lib/server/agent-runtime/billing';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('durable agent billing', () => {
  it('reuses a crashed reservation without a second charge and settles it', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    mocks.query.mockResolvedValue({ rows: [{ id: 'agent:session:message:7' }] });
    const billing = await createAgentBilling('user:account', 'session');
    await billing.reserve(7);
    await billing.finish(true);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith('account', 'agent:session:message:7');
  });
  it('reserves each steering message and releases failures', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.reserve.mockResolvedValue('reserved');
    const billing = await createAgentBilling('user:account', 'session');
    await billing.reserve(1);
    await billing.reserve(1);
    await billing.reserve(2);
    await billing.finish(false);
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it('never executes a previously completed or refunded message for free', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.reserve.mockResolvedValue('released');
    const billing = await createAgentBilling('user:account', 'session');
    await expect(billing.reserve(1)).rejects.toThrow('already finished');
  });
  it('keeps the fixed charge when cancellation follows execution admission', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [{ id: 'operation', execution_started_at: new Date() }] });
    mocks.reserve.mockResolvedValue('reserved');
    const billing = await createAgentBilling('user:account', 'session');
    await billing.reserve(1);
    await billing.markStarted(1);
    await billing.finish(false);
    expect(mocks.settle).toHaveBeenCalledWith('account', 'agent:session:message:1');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('leaves standalone generation unchanged', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'false');
    const billing = await createAgentBilling('anon:legacy', 'session');
    await billing.reserve(0);
    await billing.finish(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
