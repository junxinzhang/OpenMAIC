import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ pool: null as unknown, stripe: null as unknown }));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      Object.assign(this, state.stripe);
    }
  },
}));
vi.mock('@/lib/auth/db', () => ({ getAccountPool: () => state.pool }));
import { upgradeSubscription } from '@/lib/billing/upgrade';
import { creditSummary } from '@/lib/billing/store';
import { applyStripeEvent } from '@/lib/billing/webhook';
import type Stripe from 'stripe';
import { BILLING_SCHEMA } from '@/lib/billing/store';
const db = new PGlite();
const query = async (sql: string, params?: unknown[]) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
  if (sql === BILLING_SCHEMA) {
    await db.exec(sql);
    return { rows: [], rowCount: 0 };
  }
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
};
const plan = {
  id: 'basic',
  name: 'Basic',
  priceId: 'price_edu',
  amount: 1000,
  credits: 100,
  currency: 'usd',
};
const createSession = vi.fn();
beforeAll(async () => {
  await db.waitReady;
  state.pool = { query, connect: async () => ({ query, release() {} }) };
  await db.exec(BILLING_SCHEMA);
});
afterAll(async () => {
  await db.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE edu_credit_allocations,edu_credit_operations,edu_credit_buckets,edu_credit_ledger,edu_billing_upgrades,edu_billing_contracts,edu_billing_customers,edu_billing_checkouts,edu_billing_subscriptions,edu_billing_invoices,edu_billing_events CASCADE',
  );
  vi.stubEnv('EDU_BILLING_ENABLED', 'true');
  vi.stubEnv('EDU_BILLING_MODE', 'test');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_placeholder');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'placeholder');
  vi.stubEnv('EDU_PUBLIC_ORIGIN', 'https://edu.example');
  vi.stubEnv('EDU_BILLING_PLANS', JSON.stringify([plan]));
  createSession
    .mockReset()
    .mockResolvedValue({ id: 'cs_test', url: 'https://checkout.stripe.com/test' });
  state.stripe = {
    prices: {
      retrieve: async () => ({
        active: true,
        livemode: process.env.EDU_BILLING_MODE === 'live',
        unit_amount: 1000,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      }),
    },
    customers: {
      create: async () => ({
        id: process.env.EDU_BILLING_MODE === 'live' ? 'cus_live' : 'cus_test',
      }),
    },
    subscriptions: { list: async () => ({ has_more: false, data: [] }) },
    checkout: {
      sessions: { list: async () => ({ has_more: false, data: [] }), create: createSession },
    },
  };
});

async function setupUpgrade() {
  vi.stubEnv('EDU_BILLING_POLICY', 'cowork_v1');
  vi.stubEnv(
    'EDU_BILLING_PLANS',
    JSON.stringify([
      {
        id: 'plus',
        name: 'Plus',
        priceId: 'price_plus',
        amount: 2000,
        currency: 'usd',
        credits: 5000,
      },
      {
        id: 'pro',
        name: 'Pro',
        priceId: 'price_pro',
        amount: 10000,
        currency: 'usd',
        credits: 25000,
      },
    ]),
  );
  const start = Math.floor(Date.now() / 1000) - 1000,
    end = start + 2592000,
    newStart = start + 1000,
    newEnd = newStart + 2592000;
  await db.query(
    "INSERT INTO edu_billing_customers(user_id,customer_id) VALUES('alice','cus_test')",
  );
  await db.query(
    "INSERT INTO edu_billing_contracts(price_id,livemode,amount,currency,credits,plan_id) VALUES('price_plus',false,2000,'usd',5000,'plus')",
  );
  await db.query(
    "INSERT INTO edu_credit_buckets(id,user_id,subscription_id,credits,expires_at,period_start,plan_id) VALUES('old','alice','sub_test',5000,to_timestamp($1),to_timestamp($2),'plus')",
    [end, start],
  );
  const sub = {
    id: 'sub_test',
    livemode: false,
    customer: 'cus_test',
    metadata: { edu_user_id: 'alice' },
    status: 'active',
    discounts: [],
    automatic_tax: { enabled: false },
    default_tax_rates: [],
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_test',
          quantity: 1,
          price: { id: 'price_plus' },
          current_period_start: start,
          current_period_end: end,
        },
      ],
    },
    latest_invoice: 'in_old',
  };
  const mutate = () => {
    sub.items.data[0].price.id = 'price_pro';
    sub.items.data[0].current_period_start = newStart;
    sub.items.data[0].current_period_end = newEnd;
    sub.latest_invoice = 'in_upgrade';
    return sub;
  };
  const update = vi.fn(async (_id?: string, _params?: object, _options?: object) => mutate());
  state.stripe = {
    prices: {
      retrieve: async (id: string) => ({
        active: true,
        livemode: false,
        unit_amount: id === 'price_plus' ? 2000 : 10000,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      }),
    },
    subscriptions: {
      list: async () => ({ has_more: false, data: [sub] }),
      retrieve: async () => sub,
      update,
    },
    invoices: {
      retrieve: async () => ({
        id: 'in_upgrade',
        customer: 'cus_test',
        parent: { subscription_details: { subscription: 'sub_test' } },
        status: 'paid',
        livemode: false,
        amount_paid: 10000,
        currency: 'usd',
        billing_reason: 'subscription_update',
        lines: {
          has_more: false,
          data: [
            {
              pricing: { price_details: { price: 'price_pro' } },
              quantity: 1,
              amount: 10000,
              period: { start: newStart, end: newEnd },
            },
          ],
        },
      }),
    },
  };
  return { sub, update, mutate, start, end };
}
it('upgrades in place with a full-price new period and replaces the old allowance', async () => {
  const { update } = await setupUpgrade();
  expect(await upgradeSubscription('alice', 'pro', 'price_pro')).toEqual({
    upgraded: true,
    plan: 'pro',
  });
  expect(update).toHaveBeenCalledOnce();
  expect(update.mock.calls[0][1]).toMatchObject({
    proration_behavior: 'none',
    billing_cycle_anchor: 'now',
    payment_behavior: 'error_if_incomplete',
  });
  const summary = await creditSummary('alice');
  expect(summary.available).toBe(25000);
  expect((await db.query('SELECT * FROM edu_billing_invoices')).rows).toHaveLength(1);
  expect(
    (
      await db.query<{ active: boolean }>(
        "SELECT expires_at>now() AS active FROM edu_credit_buckets WHERE id='old'",
      )
    ).rows[0].active,
  ).toBe(false);
});
it('recovers a lost upgrade response without charging again', async () => {
  const { update, mutate } = await setupUpgrade();
  update.mockImplementationOnce(async () => {
    mutate();
    throw new Error('response lost');
  });
  await expect(upgradeSubscription('alice', 'pro', 'price_pro')).rejects.toThrow('response lost');
  await upgradeSubscription('alice', 'pro', 'price_pro');
  expect(update).toHaveBeenCalledOnce();
  expect((await creditSummary('alice')).available).toBe(25000);
});
it('preserves the subscription and credits when payment is declined', async () => {
  const { update, sub } = await setupUpgrade();
  update.mockRejectedValueOnce(Object.assign(new Error('declined'), { type: 'StripeCardError' }));
  await expect(upgradeSubscription('alice', 'pro', 'price_pro')).rejects.toMatchObject({
    code: 'payment_failed',
    status: 402,
  });
  expect(sub.items.data[0].price.id).toBe('price_plus');
  expect((await creditSummary('alice')).available).toBe(5000);
  expect((await db.query('SELECT * FROM edu_billing_invoices')).rows).toHaveLength(0);
});
it('rejects equal or lower plans before a payment request', async () => {
  const { update } = await setupUpgrade();
  await expect(upgradeSubscription('alice', 'plus', 'price_plus')).rejects.toMatchObject({
    code: 'invalid_upgrade',
  });
  expect(update).not.toHaveBeenCalled();
});

it('records a delayed original invoice without replacing upgraded credits', async () => {
  const { start, end } = await setupUpgrade();
  await upgradeSubscription('alice', 'pro', 'price_pro');
  Object.assign(state.stripe as object, {
    invoices: {
      retrieve: async () => ({
        id: 'in_late_plus',
        customer: 'cus_test',
        parent: { subscription_details: { subscription: 'sub_test' } },
        status: 'paid',
        livemode: false,
        amount_paid: 2000,
        currency: 'usd',
        billing_reason: 'subscription_create',
        lines: {
          has_more: false,
          data: [
            {
              pricing: { price_details: { price: 'price_plus' } },
              quantity: 1,
              amount: 2000,
              period: { start, end },
            },
          ],
        },
      }),
    },
  });
  await applyStripeEvent({
    id: 'evt_delayed_plus',
    type: 'invoice.paid',
    livemode: false,
    data: { object: { id: 'in_late_plus', customer: 'cus_test' } },
  } as unknown as Stripe.Event);
  expect((await creditSummary('alice')).available).toBe(25000);
  expect((await db.query('SELECT * FROM edu_billing_invoices')).rows).toHaveLength(2);
});
it('clears timestamp cancellation without sending mutually exclusive Stripe parameters', async () => {
  const { sub, update, end } = await setupUpgrade();
  Object.assign(sub, { cancel_at: end, cancel_at_period_end: false });
  await upgradeSubscription('alice', 'pro', 'price_pro');
  expect(update.mock.calls[0][1]).toMatchObject({ cancel_at: '' });
  expect(update.mock.calls[0][1]).not.toHaveProperty('cancel_at_period_end');
});
