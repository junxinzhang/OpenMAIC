import { billingPool, settleCredits, releaseCredits } from '@/lib/billing/store';
import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
  access: { ownerId?: string; billingOperationId?: string } = {},
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    let executionStarted = false;
    try {
      await markClassroomGenerationJobRunning(jobId);

      if (access.ownerId && access.billingOperationId) {
        const pool = await billingPool();
        const reservation = await pool.query(
          `UPDATE edu_credit_operations SET execution_started_at=COALESCE(execution_started_at,now())
           WHERE id=$1 AND user_id=$2 AND state='reserved' RETURNING id`,
          [access.billingOperationId, access.ownerId],
        );
        if (!reservation.rowCount) throw new Error('Classroom credits are not reserved');
      }
      executionStarted = true;

      const result = await generateClassroom(input, {
        baseUrl,
        ownerId: access.ownerId,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
      if (access.ownerId && access.billingOperationId) {
        // A payment-store outage must not turn a completed classroom into a failure.
        await settleCredits(access.ownerId, access.billingOperationId).catch(() =>
          log.error(`Completed job ${jobId} needs credit reconciliation`),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
        if (access.ownerId && access.billingOperationId) {
          await (executionStarted ? settleCredits : releaseCredits)(
            access.ownerId,
            access.billingOperationId,
          );
        }
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
