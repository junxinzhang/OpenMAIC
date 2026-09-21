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
import { createCheckout } from '@/lib/billing/stripe';
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
  await db.exec('TRUNCATE edu_billing_contracts,edu_billing_customers,edu_billing_checkouts');
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
it('commits the original terms even if the checkout response is lost, and rejects changed credits', async () => {
  createSession.mockRejectedValueOnce(new Error('response lost'));
  await expect(createCheckout('alice', 'alice@example.test', 'basic', 'price_edu')).rejects.toThrow(
    'response lost',
  );
  expect(
    (await db.query<{ credits: number }>('SELECT credits FROM edu_billing_contracts')).rows[0]
      .credits,
  ).toBe(100);
  process.env.EDU_BILLING_PLANS = JSON.stringify([{ ...plan, credits: 1 }]);
  await expect(
    createCheckout('alice', 'alice@example.test', 'basic', 'price_edu'),
  ).rejects.toMatchObject({ code: 'catalog_changed' });
  expect(createSession).toHaveBeenCalledTimes(1);
});
it('creates separate customers and checkout records for sandbox and live', async () => {
  await createCheckout('alice', 'alice@example.test', 'basic', 'price_edu');
  process.env.EDU_BILLING_MODE = 'live';
  process.env.STRIPE_SECRET_KEY = 'sk_live_placeholder';
  createSession.mockResolvedValue({ id: 'cs_live', url: 'https://checkout.stripe.com/live' });
  await createCheckout('alice', 'alice@example.test', 'basic', 'price_edu');
  expect((await db.query('SELECT * FROM edu_billing_customers')).rows).toHaveLength(2);
  expect((await db.query('SELECT * FROM edu_billing_checkouts')).rows).toHaveLength(2);
});
it('does not accept another payment while a refund or dispute is under review', async () => {
  await db.query(
    "INSERT INTO edu_billing_customers(user_id,customer_id,payment_review) VALUES('alice','cus_test',true)",
  );
  await expect(
    createCheckout('alice', 'alice@example.test', 'basic', 'price_edu'),
  ).rejects.toMatchObject({ code: 'payment_review' });
  expect(createSession).not.toHaveBeenCalled();
});
