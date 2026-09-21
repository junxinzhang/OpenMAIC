import { PGlite } from '@electric-sql/pglite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditDatabaseOwnership, auditFileOwnership } from '@/lib/maintenance/ownership-audit';
import { reconcileEduJobs } from '@/lib/maintenance/reconcile-jobs';
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edu-maintenance-'));
  directories.push(dir);
  return dir;
}
describe('read-only ownership audit', () => {
  it('reports aggregate ownership and publication without exposing content', async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(
        "CREATE TABLE stage_meta(owner_id text,is_public boolean); INSERT INTO stage_meta VALUES(NULL,false),('anon:private-identifier',false),('user:secret-identifier',true)",
      );
      await db.exec('BEGIN TRANSACTION READ ONLY');
      const report = await auditDatabaseOwnership(db as never);
      await db.exec('COMMIT');
      expect(report.stage_meta).toMatchObject({
        total: 3,
        ownerless: 1,
        anonymous: 1,
        account_owned: 1,
        public: 1,
        private: 2,
      });
      expect(JSON.stringify(report)).not.toContain('secret-identifier');
      expect(report.agent_sessions).toEqual({ present: false });
    } finally {
      await db.close();
    }
  });
  it('leaves historical files byte-identical', async () => {
    const dir = await directory();
    const text = JSON.stringify({ ownerId: 'user:secret', published: true, body: 'secret-body' });
    await fs.writeFile(path.join(dir, 'a.json'), text);
    await fs.writeFile(path.join(dir, 'b.json'), '{broken');
    const report = await auditFileOwnership(dir);
    expect(report).toMatchObject({ total: 2, accountOwned: 1, public: 1, invalid: 1 });
    expect(await fs.readFile(path.join(dir, 'a.json'), 'utf8')).toBe(text);
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
describe('terminal-only reconciliation', () => {
  it('never refunds old running jobs or uncertain render statuses', async () => {
    const dir = await directory();
    for (const [id, status] of [
      ['done', 'succeeded'],
      ['fail', 'failed'],
      ['old', 'running'],
    ])
      await fs.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          status,
          ownerId: 'user-1',
          billingOperationId: `classroom:user-1:${id}`,
          updatedAt: '2000-01-01',
        }),
      );
    const query = vi.fn(async (text: string) => ({
      rows: text.includes('to_regclass')
        ? [{ name: 'edu_render_jobs' }]
        : text.includes('SELECT r.id')
          ? [{ id: 'render-running' }, { id: 'render-done' }, { id: 'render-unknown' }]
          : [{ id: 'operation' }],
    }));
    const settle = vi.fn(),
      release = vi.fn(),
      reconcileRender = vi.fn();
    const result = await reconcileEduJobs(dir, {
      db: { query },
      settle,
      release,
      reconcileRender,
      renderStatus: async (id) => {
        if (id === 'render-unknown') throw new Error('network');
        return id === 'render-done' ? 'succeeded' : 'running';
      },
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith('user-1', 'classroom:user-1:done');
    expect(release).toHaveBeenCalledExactlyOnceWith('user-1', 'classroom:user-1:fail');
    expect(reconcileRender).toHaveBeenCalledExactlyOnceWith('render-done', 'succeeded');
    expect(result).toMatchObject({
      classroomSettled: 1,
      classroomReleased: 1,
      renderReconciled: 1,
      skipped: 2,
      errors: 1,
    });
  });
  it('settles failed classroom work when execution already began', async () => {
    const dir = await directory();
    await fs.writeFile(
      path.join(dir, 'failed.json'),
      JSON.stringify({
        status: 'failed',
        ownerId: 'one',
        billingOperationId: 'classroom:one:started',
      }),
    );
    const settle = vi.fn(),
      release = vi.fn();
    const result = await reconcileEduJobs(dir, {
      db: {
        query: async (text) => ({
          rows: text.includes('edu_credit_operations')
            ? [{ id: 'operation', execution_started_at: '2026-09-20' }]
            : [],
        }),
      },
      settle,
      release,
      reconcileRender: vi.fn(),
      renderStatus: vi.fn(),
    });
    expect(settle).toHaveBeenCalledExactlyOnceWith('one', 'classroom:one:started');
    expect(release).not.toHaveBeenCalled();
    expect(result.classroomSettled).toBe(1);
  });
  it('skips missing attribution and finalized billing operations', async () => {
    const dir = await directory();
    await fs.writeFile(
      path.join(dir, 'a.json'),
      JSON.stringify({
        status: 'succeeded',
        ownerId: 'one',
        billingOperationId: 'classroom:other:fake',
      }),
    );
    await fs.writeFile(
      path.join(dir, 'b.json'),
      JSON.stringify({
        status: 'succeeded',
        ownerId: 'one',
        billingOperationId: 'classroom:one:done',
      }),
    );
    const settle = vi.fn(),
      release = vi.fn();
    const result = await reconcileEduJobs(dir, {
      db: { query: async () => ({ rows: [] }) },
      settle,
      release,
      reconcileRender: vi.fn(),
      renderStatus: vi.fn(),
    });
    expect(result.skipped).toBe(2);
    expect(settle).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
