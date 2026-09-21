import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ pool: null as unknown, stripe: null as unknown }));
vi.mock('@/lib/billing/stripe', () => ({ stripeClient: () => state.stripe }));
vi.mock('@/lib/auth/db', () => ({ getAccountPool: () => state.pool }));
import { withBillingUsage, prepareMeteredCall } from '@/lib/billing/usage-context';
import {
  BILLING_SCHEMA,
  reserveCredits,
  settleCredits,
  releaseCredits,
  creditSummary,
} from '@/lib/billing/store';
const db = new PGlite();
let tail = Promise.resolve();
const query = async (sql: string, params?: unknown[]) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
  if (sql === BILLING_SCHEMA) {
    await db.exec(sql);
    return { rows: [], rowCount: 0 };
  }
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
};
beforeAll(async () => {
  await db.waitReady;
  state.pool = {
    query,
    connect: async () => {
      let unlock!: () => void;
      const previous = tail;
      tail = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      return { query, release: () => unlock() };
    },
  };
  await db.exec(BILLING_SCHEMA);
  await db.exec(
    'CREATE TABLE IF NOT EXISTS agent_sessions(id text PRIMARY KEY,owner_id text,status text)',
  );
});
beforeEach(async () => {
  delete process.env.EDU_BILLING_ACTION_COSTS;
  process.env.EDU_BILLING_MODE = 'test';
  process.env.EDU_BILLING_POLICY = 'cowork_v1';
  process.env.EDU_WALLET_ENABLED = 'true';
  await db.exec(
    'TRUNCATE edu_credit_ledger,edu_credit_allocations,edu_credit_operations,edu_credit_buckets,edu_billing_subscriptions,edu_billing_invoices,edu_billing_customers,edu_billing_events,edu_billing_contracts,edu_billing_checkouts,agent_sessions CASCADE',
  );
});
afterAll(async () => {
  await db.close();
});
describe('Cowork allowance policy', () => {
  it('grants one 200-credit trial and scopes it by account', async () => {
    expect((await creditSummary('alice')).available).toBe(200);
    expect((await creditSummary('alice')).available).toBe(200);
    expect(
      (await db.query("SELECT * FROM edu_credit_buckets WHERE user_id='alice'")).rows,
    ).toHaveLength(1);
    expect((await creditSummary('bob')).available).toBe(200);
  });
  it('reserves the trial allowance before a task and releases a failed task', async () => {
    await reserveCredits('alice', 'course-1', 'course_generate');
    expect((await creditSummary('alice')).reserved).toBe(200);
    expect((await creditSummary('alice')).available).toBe(0);
    await releaseCredits('alice', 'course-1');
    expect((await creditSummary('alice')).available).toBe(200);
  });
});

async function usage(id: string, input: unknown, output: unknown) {
  await withBillingUsage('alice', id, async () => {
    const call = prepareMeteredCall('gpt-5.6-terra')!;
    await call.ready;
    await call.finish({ inputTokens: input, outputTokens: output });
  });
}
describe('measured task settlement', () => {
  it('charges weighted token totals once and releases the unused reservation', async () => {
    await reserveCredits('alice', 'weighted', 'course_generate');
    await usage('weighted', 1000, 1000);
    await settleCredits('alice', 'weighted');
    await settleCredits('alice', 'weighted');
    const summary = await creditSummary('alice');
    expect(summary.available).toBe(195);
    expect(summary.reserved).toBe(0);
    expect(
      (await db.query("SELECT * FROM edu_credit_ledger WHERE kind='charge'")).rows,
    ).toHaveLength(1);
  });
  it('distinguishes explicit zero from unknown usage', async () => {
    await reserveCredits('alice', 'zero', 'course_generate');
    await usage('zero', 0, 0);
    await settleCredits('alice', 'zero');
    expect((await creditSummary('alice')).available).toBe(200);
    await reserveCredits('alice', 'unknown', 'course_generate');
    await usage('unknown', undefined, undefined);
    await settleCredits('alice', 'unknown');
    expect((await creditSummary('alice')).reserved).toBe(200);
    expect(
      (
        await db.query<{ execution_outcome: string }>(
          "SELECT execution_outcome FROM edu_credit_operations WHERE id='unknown'",
        )
      ).rows[0].execution_outcome,
    ).toBe('success');
  });
  it('rejects advanced models before provider work for a trial', async () => {
    await reserveCredits('alice', 'trial-model', 'course_generate');
    await expect(
      withBillingUsage('alice', 'trial-model', async () => prepareMeteredCall('gpt-6-astra')),
    ).rejects.toMatchObject({ code: 'plan_required' });
    expect((await db.query('SELECT * FROM edu_credit_model_calls')).rows).toHaveLength(0);
    await releaseCredits('alice', 'trial-model');
    expect((await creditSummary('alice')).available).toBe(200);
  });
  it('charges an interrupted task with known usage but fully releases a failed one', async () => {
    await reserveCredits('alice', 'cancel', 'course_generate');
    await usage('cancel', 100, 100);
    await settleCredits('alice', 'cancel', 'interrupted');
    expect((await creditSummary('alice')).available).toBe(199);
    await reserveCredits('alice', 'failure', 'course_generate');
    await usage('failure', 1000, 5000);
    await releaseCredits('alice', 'failure');
    expect((await creditSummary('alice')).available).toBe(199);
  });
  it('counts released attempts toward the hourly new-task limit', async () => {
    for (let i = 0; i < 6; i++) {
      await reserveCredits('alice', 'attempt-' + i, 'course_generate');
      await releaseCredits('alice', 'attempt-' + i);
    }
    await expect(reserveCredits('alice', 'seventh', 'course_generate')).rejects.toMatchObject({
      code: 'start_rate_limit',
    });
  });
  it('keeps paid buckets isolated from the sandbox and does not refill an exhausted trial', async () => {
    await reserveCredits('alice', 'use-all', 'course_generate');
    await usage('use-all', 500000, 500000);
    await settleCredits('alice', 'use-all');
    expect((await creditSummary('alice')).available).toBe(0);
    expect((await creditSummary('alice')).available).toBe(0);
    process.env.EDU_BILLING_MODE = 'live';
    expect((await creditSummary('alice')).available).toBe(200);
    expect(
      (await creditSummary('alice')).ledger.every(
        (r: { kind: string }) => r.kind === 'trial_grant',
      ),
    ).toBe(true);
  });
  it('settles into the original bucket after its paid period ends', async () => {
    await db.query(
      "INSERT INTO edu_credit_buckets(id,user_id,subscription_id,credits,expires_at,plan_id) VALUES('paid','alice','sub_a',5000,now()+interval '1 day','plus')",
    );
    await reserveCredits('alice', 'old-period', 'course_generate');
    await usage('old-period', 1000, 1000);
    await db.query(
      "UPDATE edu_credit_buckets SET expires_at=now()-interval '1 day' WHERE id='paid'",
    );
    await settleCredits('alice', 'old-period');
    const bucket = (
      await db.query<{ used: number; reserved: number }>(
        "SELECT used,reserved FROM edu_credit_buckets WHERE id='paid'",
      )
    ).rows[0];
    expect(Number(bucket.used)).toBe(5);
    expect(Number(bucket.reserved)).toBe(0);
    expect((await creditSummary('alice')).available).toBe(0);
  });
  it('admits only one concurrent task on Plus and caps reservations at 500', async () => {
    await db.query(
      "INSERT INTO edu_credit_buckets(id,user_id,subscription_id,credits,expires_at,plan_id) VALUES('paid','alice','sub_a',5000,now()+interval '1 day','plus')",
    );
    await reserveCredits('alice', 'one', 'course_generate');
    expect((await creditSummary('alice')).reserved).toBe(500);
    await expect(reserveCredits('alice', 'two', 'course_generate')).rejects.toMatchObject({
      code: 'concurrency_limit',
    });
  });
});
