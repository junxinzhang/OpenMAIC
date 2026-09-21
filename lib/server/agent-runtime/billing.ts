import { isBillingEnabled } from '@/lib/billing/config';
import {
  billingPool,
  ensureRunReservation,
  releaseCredits,
  settleCredits,
} from '@/lib/billing/store';

/** A durable message is charged once, including after worker recovery. */
export async function createAgentBilling(ownerId: string, sessionId: string) {
  const enabled = isBillingEnabled();
  const userId = ownerId.startsWith('user:') ? ownerId.slice(5) : '';
  const prefix = `agent:${sessionId}:message:`;
  const reserved = new Set<string>();
  if (enabled) {
    if (!userId) throw new Error('Authentication required for paid generation');
    const pool = await billingPool();
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM edu_credit_operations WHERE user_id=$1 AND left(id,length($2))=$2 AND state='reserved'",
      [userId, prefix],
    );
    for (const row of rows.rows) reserved.add(row.id);
  }
  return {
    async reserve(messageSeq: number) {
      if (!enabled) return;
      const operationId = `${prefix}${messageSeq}`;
      if (reserved.has(operationId)) return;
      const state = await ensureRunReservation(userId, operationId, 'agent.message');
      if (state !== 'reserved')
        throw new Error('This message has already finished; send a new message to continue');
      reserved.add(operationId);
    },
    async markStarted(messageSeq: number) {
      if (!enabled) return;
      const operationId = `${prefix}${messageSeq}`;
      const pool = await billingPool();
      const result = await pool.query(
        `UPDATE edu_credit_operations SET execution_started_at=COALESCE(execution_started_at,now())
          WHERE id=$1 AND user_id=$2 AND state='reserved' RETURNING id`,
        [operationId, userId],
      );
      if (!result.rows.length) throw new Error('Paid operation is not reserved');
    },
    async finish(success: boolean) {
      if (!enabled) return;
      for (const operationId of reserved) {
        const pool = await billingPool();
        const result = await pool.query<{ execution_started_at: unknown }>(
          'SELECT execution_started_at FROM edu_credit_operations WHERE id=$1 AND user_id=$2',
          [operationId, userId],
        );
        // Work already admitted to the provider keeps its fixed task charge;
        // otherwise cancellation could obtain unlimited partial generations.
        const charge = success || result.rows[0]?.execution_started_at != null;
        await (charge ? settleCredits : releaseCredits)(userId, operationId);
        reserved.delete(operationId);
      }
    },
  };
}
