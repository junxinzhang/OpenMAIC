import { isBillingEnabled } from '@/lib/billing/config';
import { billingPool } from '@/lib/billing/store';

/** Extraction is only queued by an agent tool and is included in that task's price. */
export async function assertMaterialExtractionFunded(sessionId: string): Promise<void> {
  if (!isBillingEnabled()) return;
  const pool = await billingPool();
  const paid = await pool.query(
    `SELECT 1 FROM agent_sessions s
       JOIN edu_credit_operations o ON s.owner_id='user:' || o.user_id
      WHERE s.id=$1 AND s.deleted_at IS NULL
        AND left(o.id,length($2))=$2 AND o.action='agent.message'
        AND o.state IN ('reserved','settled') AND o.execution_started_at IS NOT NULL
      LIMIT 1`,
    [sessionId, `agent:${sessionId}:message:`],
  );
  if (!paid.rows.length) throw new Error('Material extraction requires a funded account task');
}
