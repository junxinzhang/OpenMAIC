/** Read-only: pnpm exec tsx scripts/audit-edu-ownership.ts */
import path from 'node:path';
import { getAccountPool } from '../lib/auth/db';
import { auditDatabaseOwnership, auditFileOwnership } from '../lib/maintenance/ownership-audit';
async function main() {
  const pool = getAccountPool();
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const database = await auditDatabaseOwnership(db);
    await db.query('COMMIT');
    const classrooms = await auditFileOwnership(
      process.env.OPENMAIC_CLASSROOMS_DIR || path.join(process.cwd(), 'data', 'classrooms'),
    );
    const jobs = await auditFileOwnership(path.join(process.cwd(), 'data', 'classroom-jobs'));
    console.log(
      JSON.stringify(
        {
          readOnly: true,
          generatedAt: new Date().toISOString(),
          database,
          files: { classrooms, jobs },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error('Ownership audit failed; check database access and local file permissions.');
  process.exitCode = 1;
});
