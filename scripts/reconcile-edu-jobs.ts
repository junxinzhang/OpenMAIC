/** Terminal evidence only: pnpm exec tsx scripts/reconcile-edu-jobs.ts */
import path from 'node:path';
import { isBillingEnabled } from '../lib/billing/config';
import { isAuthEnabled } from '../lib/auth/config';
import { billingPool, settleCredits, releaseCredits } from '../lib/billing/store';
import { resolveRenderServiceUrl } from '../lib/server/render-service';
import { reconcileRenderJob } from '../lib/server/render-account';
import { proxyFetch } from '../lib/server/proxy-fetch';
import { reconcileEduJobs } from '../lib/maintenance/reconcile-jobs';
async function main() {
  if (!isBillingEnabled() || !isAuthEnabled()) throw new Error('Account billing must be enabled');
  const pool = await billingPool();
  try {
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
        if (!response.ok) throw new Error('Render status is unknown');
        const body = (await response.json()) as { status?: unknown };
        return body.status;
      },
    });
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('Job reconciliation failed; no timeout-based refunds were performed.');
  process.exitCode = 1;
});
