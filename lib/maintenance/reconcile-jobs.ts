import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AuditDb } from './ownership-audit';
export interface JobReconcileDeps {
  db: AuditDb;
  settle(userId: string, operationId: string): Promise<unknown>;
  release(userId: string, operationId: string): Promise<unknown>;
  renderStatus(jobId: string): Promise<unknown>;
  reconcileRender(jobId: string, state: unknown): Promise<unknown>;
}
/** Raw files are deliberate: the UI reader synthesizes "stale" failures. */
export async function reconcileEduJobs(directory: string, deps: JobReconcileDeps) {
  const counts = {
    classroomSettled: 0,
    classroomReleased: 0,
    renderReconciled: 0,
    skipped: 0,
    errors: 0,
  };
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const file = path.join(directory, entry.name);
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) {
        counts.skipped++;
        continue;
      }
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        !job ||
        !['succeeded', 'failed'].includes(job.status) ||
        typeof job.ownerId !== 'string' ||
        !job.ownerId ||
        typeof job.billingOperationId !== 'string' ||
        !job.billingOperationId.startsWith(`classroom:${job.ownerId}:`)
      ) {
        counts.skipped++;
        continue;
      }
      const operation = await deps.db.query(
        "SELECT id,execution_started_at FROM edu_credit_operations WHERE id=$1 AND user_id=$2 AND action='course_generate' AND state='reserved'",
        [job.billingOperationId, job.ownerId],
      );
      if (!operation.rows.length) {
        counts.skipped++;
        continue;
      }
      if (job.status === 'succeeded' || operation.rows[0]?.execution_started_at != null) {
        await deps.settle(job.ownerId, job.billingOperationId);
        counts.classroomSettled++;
      } else {
        await deps.release(job.ownerId, job.billingOperationId);
        counts.classroomReleased++;
      }
    } catch {
      counts.errors++;
    }
  }
  const table = await deps.db.query("SELECT to_regclass('edu_render_jobs') AS name");
  if (!table.rows[0]?.name) return counts;
  const renders = await deps.db.query(
    `SELECT r.id FROM edu_render_jobs r JOIN edu_credit_operations o ON o.id=r.operation_id
       WHERE o.user_id=r.user_id AND o.action='video_render' AND o.state='reserved'
       ORDER BY r.created_at LIMIT 1000`,
  );
  for (const job of renders.rows) {
    try {
      const status = await deps.renderStatus(String(job.id));
      if (!['succeeded', 'failed', 'cancelled'].includes(String(status))) {
        counts.skipped++;
        continue;
      }
      await deps.reconcileRender(String(job.id), status);
      counts.renderReconciled++;
    } catch {
      counts.errors++;
    }
  }
  return counts;
}
