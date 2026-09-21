import path from 'node:path';
import { isAuthEnabled } from '@/lib/auth/config';
import { isBillingEnabled } from '@/lib/billing/config';
import {
  billingPool,
  reconcileAgentReservation,
  settleCredits,
  releaseCredits,
} from '@/lib/billing/store';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import { reconcileRenderJob } from '@/lib/server/render-account';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { reconcileEduJobs } from './reconcile-jobs';

export async function reconcileTerminalBilling(): Promise<void> {
  const pool = await billingPool();
  const table = await pool.query("SELECT to_regclass('agent_sessions') AS name");
  if (table.rows[0]?.name) {
    const operations = await pool.query<{ id: string }>(
      `SELECT o.id FROM edu_credit_operations o JOIN agent_sessions s ON s.id=split_part(o.id,':',2)
        WHERE o.state='reserved' AND o.id LIKE 'agent:%:message:%'
          AND s.owner_id='user:' || o.user_id AND s.status IN ('succeeded','failed','cancelled')
        ORDER BY o.created_at LIMIT 1000`,
    );
    for (const operation of operations.rows) {
      try {
        await reconcileAgentReservation(operation.id);
      } catch {
        console.error('[billing-reconciliation] Agent settlement will retry');
      }
    }
  }
  const result = await reconcileEduJobs(path.join(process.cwd(), 'data', 'classroom-jobs'), {
    db: pool,
    settle: settleCredits,
    release: releaseCredits,
    reconcileRender: reconcileRenderJob,
    async renderStatus(id) {
      const service = resolveRenderServiceUrl();
      if ('error' in service) throw new Error('Render service unavailable');
      const response = await proxyFetch(`${service.url}/render/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Unknown render status');
      return ((await response.json()) as { status?: unknown }).status;
    },
  });
  if (result.errors)
    console.error('[billing-reconciliation] Some jobs could not be verified and will retry');
}

/** Each worker may run this; final ledger transitions are durable and idempotent. */
export function startBillingReconciliationSchedule(
  options: { run?: () => Promise<void>; intervalMs?: number } = {},
): { stop(): Promise<void> } {
  if (!isAuthEnabled() || !isBillingEnabled()) return { async stop() {} };
  let stopped = false;
  let running: Promise<void> | undefined;
  const run = options.run ?? reconcileTerminalBilling;
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve()
      .then(run)
      .catch(() => {
        console.error(
          '[billing-reconciliation] Reconciliation unavailable; retrying on the next cycle',
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? 60000);
  timer.unref?.();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
