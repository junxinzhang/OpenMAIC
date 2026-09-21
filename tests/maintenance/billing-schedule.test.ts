import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/billing/store', () => ({}));
vi.mock('@/lib/server/render-service', () => ({}));
vi.mock('@/lib/server/render-account', () => ({}));
vi.mock('@/lib/server/proxy-fetch', () => ({}));
import { startBillingReconciliationSchedule } from '@/lib/maintenance/billing-schedule';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('billing reconciliation schedule', () => {
  it('starts only when both account and billing mode are enabled', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'false');
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    const run = vi.fn();
    const handle = startBillingReconciliationSchedule({ run });
    await handle.stop();
    expect(run).not.toHaveBeenCalled();
  });
  it('does not overlap runs and waits for active work on shutdown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handle = startBillingReconciliationSchedule({ run });
    await vi.advanceTimersByTimeAsync(180000);
    expect(run).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await vi.advanceTimersByTimeAsync(120000);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('survives a failed cycle and retries later', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const handle = startBillingReconciliationSchedule({ run });
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(2);
    await handle.stop();
  });
});
