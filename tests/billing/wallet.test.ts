import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ pool: null as unknown, stripe: null as unknown }));
vi.mock('@/lib/billing/stripe', () => ({ stripeClient: () => state.stripe }));
vi.mock('@/lib/auth/db', () => ({ getAccountPool: () => state.pool }));
import { applyStripeEvent } from '@/lib/billing/webhook';
import type Stripe from 'stripe';
import {
  BILLING_SCHEMA,
  reserveCredits,
  settleCredits,
  releaseCredits,
  ensureRunReservation,
  creditSummary,
  reconcileAgentReservation,
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
  await db.exec(
    'TRUNCATE edu_credit_ledger,edu_credit_allocations,edu_credit_operations,edu_credit_buckets,edu_billing_subscriptions,edu_billing_invoices,edu_billing_customers,edu_billing_events,edu_billing_contracts,edu_billing_checkouts,agent_sessions CASCADE',
  );
});
afterAll(async () => {
  await db.close();
});
async function grant(user = 'alice', credits = 10, id = 'grant', expired = false) {
  await db.query(
    'INSERT INTO edu_credit_buckets(id,user_id,credits,expires_at) VALUES($1,$2,$3,now()+$4::interval)',
    [id, user, credits, expired ? '-1 day' : '1 day'],
  );
}
describe('durable credit wallet', () => {
  it('never displays or spends sandbox funds in live mode, and settles original reservations', async () => {
    await grant();
    await reserveCredits('alice', 'sandbox-run', 'generate');
    process.env.EDU_BILLING_MODE = 'live';
    expect((await creditSummary('alice')).available).toBe(0);
    expect((await creditSummary('alice')).reserved).toBe(0);
    expect((await creditSummary('alice')).ledger).toHaveLength(0);
    await expect(reserveCredits('alice', 'live-run', 'generate')).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    await expect(ensureRunReservation('alice', 'sandbox-run', 'generate')).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    await settleCredits('alice', 'sandbox-run');
    expect((await creditSummary('alice')).ledger).toHaveLength(0);
    process.env.EDU_BILLING_MODE = 'test';
    expect((await creditSummary('alice')).available).toBe(9);
    expect((await creditSummary('alice')).reserved).toBe(0);
  });
  it('reserves and settles once, without exposing another account', async () => {
    await grant();
    await reserveCredits('alice', 'run1', 'generate');
    expect((await creditSummary('alice')).available).toBe(9);
    expect((await creditSummary('bob')).available).toBe(0);
    await settleCredits('alice', 'run1');
    await settleCredits('alice', 'run1');
    expect((await creditSummary('alice')).reserved).toBe(0);
    expect((await creditSummary('alice')).available).toBe(9);
  });
  it('rejects duplicate public requests and cross-account settlement', async () => {
    await grant();
    await reserveCredits('alice', 'run1', 'generate');
    await expect(reserveCredits('alice', 'run1', 'generate')).rejects.toMatchObject({
      code: 'operation_exists',
    });
    await expect(settleCredits('bob', 'run1')).rejects.toMatchObject({ code: 'operation_missing' });
    expect(await ensureRunReservation('alice', 'run1', 'generate')).toBe('reserved');
    await expect(ensureRunReservation('bob', 'run1', 'generate')).rejects.toMatchObject({
      code: 'operation_conflict',
    });
  });
  it('allows only one concurrent reservation against the last credit', async () => {
    await grant('alice', 1);
    const results = await Promise.allSettled([
      reserveCredits('alice', 'a', 'generate'),
      reserveCredits('alice', 'b', 'generate'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await creditSummary('alice')).available).toBe(0);
  });
  it('releases failures once and never resurrects expired balance', async () => {
    await grant();
    await reserveCredits('alice', 'run1', 'generate');
    await db.query("UPDATE edu_credit_buckets SET expires_at=now()-interval '1 second'");
    await releaseCredits('alice', 'run1');
    await releaseCredits('alice', 'run1');
    expect((await creditSummary('alice')).available).toBe(0);
    expect((await creditSummary('alice')).reserved).toBe(0);
    await expect(reserveCredits('alice', 'run2', 'generate')).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
  });
  it('settles against original bucket after expiry and splits across buckets', async () => {
    process.env.EDU_BILLING_ACTION_COSTS = '{"generate":3}';
    await grant('alice', 2, 'a');
    await grant('alice', 2, 'b');
    await reserveCredits('alice', 'run1', 'generate');
    await db.query("UPDATE edu_credit_buckets SET expires_at=now()-interval '1 second'");
    await settleCredits('alice', 'run1');
    const result = await db.query<{ used: number }>(
      'SELECT SUM(used)::int AS used FROM edu_credit_buckets',
    );
    expect(result.rows[0].used).toBe(3);
  });
});

describe('terminal agent recovery', () => {
  it('settles a started failure and releases a never-started failure; skips running tasks', async () => {
    await grant();
    for (const [id, status, started] of [
      ['a', 'failed', true],
      ['b', 'failed', false],
      ['c', 'running', true],
    ] as const) {
      await db.query('INSERT INTO agent_sessions(id,owner_id,status) VALUES($1,$2,$3)', [
        id,
        'user:alice',
        status,
      ]);
      await reserveCredits('alice', `agent:${id}:message:0`, 'workbench_run');
      if (started)
        await db.query('UPDATE edu_credit_operations SET execution_started_at=now() WHERE id=$1', [
          `agent:${id}:message:0`,
        ]);
    }
    expect(await reconcileAgentReservation('agent:a:message:0')).toBe('settled');
    expect(await reconcileAgentReservation('agent:b:message:0')).toBe('released');
    expect(await reconcileAgentReservation('agent:c:message:0')).toBe('skipped');
    expect(await reconcileAgentReservation('agent:a:message:0')).toBe('skipped');
    expect((await creditSummary('alice')).available).toBe(8);
  });
});

describe('Stripe event accounting', () => {
  it('grants once for distinct events referencing the same paid invoice and preserves the owner', async () => {
    process.env.EDU_BILLING_MODE = 'test';
    process.env.EDU_BILLING_PLANS = JSON.stringify([
      {
        id: 'basic',
        name: 'Basic',
        priceId: 'price_edu',
        credits: 100,
        amount: 1000,
        currency: 'usd',
      },
    ]);
    await db.query('INSERT INTO edu_billing_customers(user_id,customer_id) VALUES($1,$2)', [
      'alice',
      'cus_edu',
    ]);
    await db.query("INSERT INTO edu_billing_contracts VALUES('price_edu',false,1000,'usd',100)");
    const start = Math.floor(Date.now() / 1000);
    const end = start + 2592000;
    const invoice = {
      id: 'in_edu',
      customer: 'cus_edu',
      parent: { subscription_details: { subscription: 'sub_edu' } },
      status: 'paid',
      livemode: false,
      amount_paid: 1000,
      currency: 'usd',
      billing_reason: 'subscription_create',
      lines: {
        has_more: false,
        data: [
          {
            pricing: { price_details: { price: 'price_edu' } },
            quantity: 1,
            amount: 1000,
            period: { start, end },
          },
        ],
      },
    };
    state.stripe = {
      invoices: { retrieve: async () => invoice },
      subscriptions: {
        list: async () => ({
          has_more: false,
          data: [{ id: 'sub_edu', metadata: { edu_user_id: 'alice' }, status: 'active' }],
        }),
        update: vi.fn(async () => ({})),
        retrieve: async () => ({
          id: 'sub_edu',
          customer: 'cus_edu',
          metadata: { edu_user_id: 'alice' },
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_edu' }, current_period_end: end }] },
        }),
      },
    };
    const event = (id: string) =>
      ({
        id,
        type: 'invoice.paid',
        livemode: false,
        data: { object: { id: 'in_edu', customer: 'cus_edu' } },
      }) as unknown as Stripe.Event;
    process.env.EDU_BILLING_PLANS = '[]'; // Retiring a catalog entry cannot revoke its purchased contract.
    await applyStripeEvent(event('evt_a'));
    await applyStripeEvent(event('evt_a'));
    await applyStripeEvent(event('evt_b'));
    expect((await creditSummary('alice')).available).toBe(100);
    expect((await creditSummary('bob')).available).toBe(0);
    await applyStripeEvent({
      id: 'evt_refund',
      type: 'charge.refunded',
      livemode: false,
      data: { object: { id: 'ch_edu', customer: 'cus_edu' } },
    } as unknown as Stripe.Event);
    expect(
      (state.stripe as { subscriptions: { update: ReturnType<typeof vi.fn> } }).subscriptions
        .update,
    ).toHaveBeenCalledWith(
      'sub_edu',
      { pause_collection: { behavior: 'void' }, cancel_at_period_end: true },
      expect.any(Object),
    );
    invoice.id = 'in_late';
    await applyStripeEvent(event('evt_late'));
    expect((await creditSummary('alice')).available).toBe(0);

    const held = (
      await db.query<{ held: boolean; expires_at: Date }>(
        "SELECT held,expires_at FROM edu_credit_buckets WHERE id='invoice:in_late'",
      )
    ).rows[0];
    expect(held.held).toBe(true);
    expect(new Date(held.expires_at).getTime()).toBe(end * 1000);
    expect((await db.query('SELECT * FROM edu_billing_invoices')).rows).toHaveLength(2);
    invoice.amount_paid = 500;
    await expect(applyStripeEvent(event('evt_bad'))).rejects.toMatchObject({
      code: 'invalid_invoice',
    });
    expect(
      (await db.query("SELECT * FROM edu_billing_events WHERE event_id='evt_bad'")).rows,
    ).toHaveLength(0);
  });
});
