import { getAccountPool } from '@/lib/auth/db';
import { isAuthEnabled } from '@/lib/auth/config';
import { getRequestUser } from '@/lib/auth/session';
import { settleCredits, releaseCredits } from '@/lib/billing/store';

let ready: Promise<unknown> | undefined;
async function renderPool() {
  const pool = getAccountPool();
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS edu_render_jobs (
    id text PRIMARY KEY, user_id text NOT NULL, operation_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
    )
    .catch((error) => {
      ready = undefined;
      throw error;
    });
  await ready;
  return pool;
}
export async function rememberRenderJob(id: string, userId: string, operationId?: string) {
  await (
    await renderPool()
  ).query('INSERT INTO edu_render_jobs(id,user_id,operation_id) VALUES($1,$2,$3)', [
    id,
    userId,
    operationId ?? null,
  ]);
}
export async function ownsRenderJob(req: Request, id: string): Promise<boolean> {
  if (!isAuthEnabled()) return true;
  const user = await getRequestUser(req);
  if (!user) return false;
  const result = await (
    await renderPool()
  ).query('SELECT 1 FROM edu_render_jobs WHERE id=$1 AND user_id=$2', [id, user.id]);
  return Boolean(result.rowCount);
}
/** Called only for a terminal state reported by the trusted render service. */
export async function reconcileRenderJob(id: string, state: unknown) {
  if (!isAuthEnabled() || !['succeeded', 'failed', 'cancelled'].includes(String(state))) return;
  const result = await (
    await renderPool()
  ).query('SELECT user_id,operation_id FROM edu_render_jobs WHERE id=$1', [id]);
  const job = result.rows[0];
  if (!job?.operation_id) return;
  // Cancelled work may already have consumed resources. Charge the fixed render
  // operation; only a confirmed failure releases it under this policy.
  if (state === 'failed') await releaseCredits(job.user_id, job.operation_id);
  else await settleCredits(job.user_id, job.operation_id);
}
