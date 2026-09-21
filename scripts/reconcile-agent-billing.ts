/** Run with the deployment environment loaded: pnpm exec tsx scripts/reconcile-agent-billing.ts */
import { isBillingEnabled } from '../lib/billing/config';
import { billingPool, reconcileAgentReservation } from '../lib/billing/store';

async function main() {
  if (!isBillingEnabled()) throw new Error('EDU_BILLING_ENABLED must be true');
  const pool = await billingPool();
  try {
    const candidates = await pool.query<{ id: string }>(
      `SELECT o.id FROM edu_credit_operations o
         JOIN agent_sessions s ON s.id=split_part(o.id,':',2)
        WHERE o.state='reserved' AND o.id LIKE 'agent:%:message:%'
          AND s.owner_id='user:' || o.user_id
          AND s.status IN ('succeeded','failed','cancelled')
        ORDER BY o.created_at LIMIT 1000`,
    );
    const results = { settled: 0, released: 0, skipped: 0 };
    for (const row of candidates.rows) results[await reconcileAgentReservation(row.id)] += 1;
    console.log(JSON.stringify({ examined: candidates.rows.length, ...results }));
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Reconciliation failed');
  process.exitCode = 1;
});
