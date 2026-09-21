import { afterEach, describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/store', () => ({ billingPool: async () => ({ query }) }));
import { assertMaterialExtractionFunded } from '@/lib/server/material-extraction/billing';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('background extraction funding boundary', () => {
  it('refuses legacy or unfunded queued work in billing mode', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    query.mockResolvedValue({ rows: [] });
    await expect(assertMaterialExtractionFunded('session')).rejects.toThrow('funded account task');
  });
  it('uses the already-paid agent task without charging a second extraction fee', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'true');
    query.mockResolvedValue({ rows: [{}] });
    await expect(assertMaterialExtractionFunded('session')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("o.state IN ('reserved','settled')"),
      ['session', 'agent:session:message:'],
    );
  });
  it('preserves standalone extraction when billing is disabled', async () => {
    vi.stubEnv('EDU_BILLING_ENABLED', 'false');
    await assertMaterialExtractionFunded('legacy');
    expect(query).not.toHaveBeenCalled();
  });
});
