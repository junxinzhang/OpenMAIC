import { getAccountPool } from '@/lib/auth/db';
import { BillingError, operationCost, billingMode } from './config';
import { isCoworkBilling } from './policy';
import type { Pool, PoolClient } from 'pg';

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS edu_billing_customers(user_id text PRIMARY KEY, customer_id text UNIQUE NOT NULL);
ALTER TABLE edu_billing_customers ADD COLUMN IF NOT EXISTS payment_review boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS edu_billing_subscriptions(subscription_id text PRIMARY KEY,user_id text NOT NULL,customer_id text NOT NULL,status text NOT NULL,price_id text NOT NULL,cancel_at_period_end boolean NOT NULL DEFAULT false,period_end timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS edu_billing_events(event_id text PRIMARY KEY,processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS edu_credit_buckets(id text PRIMARY KEY,user_id text NOT NULL,subscription_id text,credits bigint NOT NULL CHECK(credits>=0),used bigint NOT NULL DEFAULT 0 CHECK(used>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(used+reserved<=credits));
CREATE INDEX IF NOT EXISTS edu_credit_buckets_owner ON edu_credit_buckets(user_id,expires_at);
CREATE TABLE IF NOT EXISTS edu_credit_operations(id text PRIMARY KEY,user_id text NOT NULL,action text NOT NULL,cost bigint NOT NULL,state text NOT NULL CHECK(state IN ('reserved','settled','released')),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
CREATE TABLE IF NOT EXISTS edu_credit_allocations(operation_id text NOT NULL REFERENCES edu_credit_operations(id),bucket_id text NOT NULL REFERENCES edu_credit_buckets(id),credits bigint NOT NULL CHECK(credits>0),PRIMARY KEY(operation_id,bucket_id));
CREATE TABLE IF NOT EXISTS edu_credit_ledger(id bigserial PRIMARY KEY,user_id text NOT NULL,operation_id text,kind text NOT NULL,credits bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS edu_billing_invoices(invoice_id text PRIMARY KEY,user_id text NOT NULL,subscription_id text NOT NULL,amount bigint NOT NULL,currency text NOT NULL,credits bigint NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS edu_billing_checkouts(user_id text PRIMARY KEY,generation integer NOT NULL DEFAULT 1,plan_id text NOT NULL,price_id text NOT NULL,session_id text,url text,state text NOT NULL DEFAULT 'pending');

ALTER TABLE edu_billing_customers ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='edu_billing_customers'::regclass AND contype='p' AND cardinality(conkey)=1) THEN
  ALTER TABLE edu_billing_customers DROP CONSTRAINT edu_billing_customers_pkey;
  ALTER TABLE edu_billing_customers ADD PRIMARY KEY(user_id,livemode);
END IF;
END $$;
ALTER TABLE edu_billing_checkouts ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='edu_billing_checkouts'::regclass AND contype='p' AND cardinality(conkey)=1) THEN
  ALTER TABLE edu_billing_checkouts DROP CONSTRAINT edu_billing_checkouts_pkey;
  ALTER TABLE edu_billing_checkouts ADD PRIMARY KEY(user_id,livemode);
END IF;
END $$;
ALTER TABLE edu_credit_buckets ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
ALTER TABLE edu_credit_buckets ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
ALTER TABLE edu_credit_ledger ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
ALTER TABLE edu_billing_subscriptions ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
ALTER TABLE edu_billing_invoices ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS edu_billing_contracts(price_id text NOT NULL,livemode boolean NOT NULL,amount bigint NOT NULL,currency text NOT NULL,credits bigint NOT NULL,PRIMARY KEY(price_id,livemode));

ALTER TABLE edu_credit_buckets ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE edu_credit_buckets ADD COLUMN IF NOT EXISTS period_start timestamptz NOT NULL DEFAULT now();
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS billing_policy text NOT NULL DEFAULT 'fixed';
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS execution_outcome text;
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS charged bigint;
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS input_tokens bigint;
ALTER TABLE edu_credit_operations ADD COLUMN IF NOT EXISTS output_tokens bigint;
ALTER TABLE edu_billing_contracts ADD COLUMN IF NOT EXISTS plan_id text;
CREATE TABLE IF NOT EXISTS edu_credit_model_calls(id text PRIMARY KEY,operation_id text NOT NULL REFERENCES edu_credit_operations(id),model text NOT NULL,state text NOT NULL DEFAULT 'pending',input_tokens bigint,output_tokens bigint,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS edu_credit_model_calls_operation ON edu_credit_model_calls(operation_id);
CREATE TABLE IF NOT EXISTS edu_billing_upgrades(id text PRIMARY KEY,user_id text NOT NULL,subscription_id text NOT NULL,price_id text NOT NULL,previous_price_id text NOT NULL,livemode boolean NOT NULL,state text NOT NULL DEFAULT 'pending',invoice_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS edu_credit_operations_owner_time ON edu_credit_operations(user_id,livemode,created_at);
CREATE INDEX IF NOT EXISTS edu_credit_operations_active ON edu_credit_operations(livemode) WHERE state='reserved' AND execution_outcome IS NULL AND billing_policy='cowork_v1';
CREATE INDEX IF NOT EXISTS edu_billing_invoices_owner_time ON edu_billing_invoices(user_id,livemode,created_at);
CREATE TABLE IF NOT EXISTS edu_credit_media_calls(id text PRIMARY KEY,operation_id text NOT NULL REFERENCES edu_credit_operations(id),action text NOT NULL,credits bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
`;
let schemaPromise: Promise<unknown> | undefined;
export async function billingPool(): Promise<Pool> {
  const pool = getAccountPool();
  if (!schemaPromise)
    schemaPromise = pool.query(BILLING_SCHEMA).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  await schemaPromise;
  return pool;
}
export async function billingTransaction<T>(body: (db: PoolClient) => Promise<T>): Promise<T> {
  const pool = await billingPool();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await body(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function lockBillingUser(db: PoolClient, userId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['edu-billing:' + userId]);
}
export async function reserveCredits(
  userId: string,
  operationId: string,
  action: string,
): Promise<void> {
  if (isCoworkBilling())
    return (await import('./cowork-store')).reserveCoworkCredits(userId, operationId, action);
  const cost = operationCost(action);
  if (!operationId || operationId.length > 200)
    throw new BillingError('invalid_operation', '任务标识无效');
  await billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const old = await db.query('SELECT id FROM edu_credit_operations WHERE id=$1', [operationId]);
    if (old.rowCount) throw new BillingError('operation_exists', '该请求已处理，请查看原任务', 409);
    const buckets = await db.query(
      'SELECT * FROM edu_credit_buckets WHERE user_id=$1 AND livemode=$2 AND NOT held AND expires_at>now() AND credits>used+reserved ORDER BY expires_at,id FOR UPDATE',
      [userId, billingMode()],
    );
    if (
      buckets.rows.reduce(
        (sum, r) => sum + Number(r.credits) - Number(r.used) - Number(r.reserved),
        0,
      ) < cost
    )
      throw new BillingError('insufficient_credits', '积分不足，请前往账户页面查看', 402);
    await db.query(
      "INSERT INTO edu_credit_operations(id,user_id,action,cost,state,livemode) VALUES($1,$2,$3,$4,'reserved',$5)",
      [operationId, userId, action, cost, billingMode()],
    );
    let remaining = cost;
    for (const bucket of buckets.rows) {
      const take = Math.min(
        remaining,
        Number(bucket.credits) - Number(bucket.used) - Number(bucket.reserved),
      );
      if (!take) continue;
      await db.query('UPDATE edu_credit_buckets SET reserved=reserved+$2 WHERE id=$1', [
        bucket.id,
        take,
      ]);
      await db.query(
        'INSERT INTO edu_credit_allocations(operation_id,bucket_id,credits) VALUES($1,$2,$3)',
        [operationId, bucket.id, take],
      );
      remaining -= take;
      if (!remaining) break;
    }
    await db.query(
      "INSERT INTO edu_credit_ledger(user_id,operation_id,kind,credits,livemode) VALUES($1,$2,'reserve',$3,$4)",
      [userId, operationId, -cost, billingMode()],
    );
  });
}
async function finishCreditsInTransaction(
  db: PoolClient,
  userId: string,
  operationId: string,
  state: 'settled' | 'released',
) {
  await lockBillingUser(db, userId);
  const result = await db.query(
    'SELECT * FROM edu_credit_operations WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [operationId, userId],
  );
  const operation = result.rows[0];
  if (!operation) throw new BillingError('operation_missing', '任务记录不存在', 404);
  if (operation.state === state) return;
  if (operation.state !== 'reserved')
    throw new BillingError('operation_finalized', '任务已经结算', 409);
  const allocations = await db.query('SELECT * FROM edu_credit_allocations WHERE operation_id=$1', [
    operationId,
  ]);
  for (const row of allocations.rows)
    await db.query('UPDATE edu_credit_buckets SET reserved=reserved-$2,used=used+$3 WHERE id=$1', [
      row.bucket_id,
      row.credits,
      state === 'settled' ? row.credits : 0,
    ]);
  await db.query('UPDATE edu_credit_operations SET state=$2,finished_at=now() WHERE id=$1', [
    operationId,
    state,
  ]);
  await db.query(
    'INSERT INTO edu_credit_ledger(user_id,operation_id,kind,credits,livemode) VALUES($1,$2,$3,$4,$5)',
    [userId, operationId, state, state === 'released' ? operation.cost : 0, operation.livemode],
  );
}
async function finishCredits(
  userId: string,
  operationId: string,
  state: 'settled' | 'released',
  outcome: 'success' | 'interrupted' | 'failed' = state === 'released' ? 'failed' : 'success',
) {
  const op = (
    await (
      await billingPool()
    ).query('SELECT billing_policy FROM edu_credit_operations WHERE id=$1 AND user_id=$2', [
      operationId,
      userId,
    ])
  ).rows[0];
  if (op?.billing_policy === 'cowork_v1')
    return (await import('./cowork-store')).finishCoworkCredits(userId, operationId, outcome);
  await billingTransaction((db) => finishCreditsInTransaction(db, userId, operationId, state));
}
export async function reconcileAgentReservation(
  operationId: string,
): Promise<'settled' | 'released' | 'skipped'> {
  const match = /^agent:([^:]+):message:\d+$/.exec(operationId);
  if (!match) return 'skipped';
  const pool = await billingPool();
  const recovered = (
    await pool.query(
      'SELECT o.user_id,o.billing_policy,o.state,o.execution_outcome,s.status,s.owner_id FROM edu_credit_operations o JOIN agent_sessions s ON s.id=$2 WHERE o.id=$1',
      [operationId, match[1]],
    )
  ).rows[0];
  if (recovered?.billing_policy === 'cowork_v1') {
    if (
      recovered.state !== 'reserved' ||
      recovered.owner_id !== 'user:' + recovered.user_id ||
      !['succeeded', 'failed', 'cancelled'].includes(recovered.status)
    )
      return 'skipped';
    const outcome =
      recovered.execution_outcome ??
      (recovered.status === 'succeeded'
        ? 'success'
        : recovered.status === 'cancelled'
          ? 'interrupted'
          : 'failed');
    await (
      await import('./cowork-store')
    ).finishCoworkCredits(recovered.user_id, operationId, outcome);
    return outcome === 'failed' ? 'released' : 'settled';
  }
  return billingTransaction(async (db) => {
    const session = (
      await db.query('SELECT owner_id,status FROM agent_sessions WHERE id=$1 FOR UPDATE', [
        match[1],
      ])
    ).rows[0];
    if (!session || !['succeeded', 'failed', 'cancelled'].includes(session.status))
      return 'skipped';
    const operation = (
      await db.query(
        'SELECT user_id,state,execution_started_at FROM edu_credit_operations WHERE id=$1',
        [operationId],
      )
    ).rows[0];
    if (
      !operation ||
      operation.state !== 'reserved' ||
      session.owner_id !== 'user:' + operation.user_id
    )
      return 'skipped';
    const target =
      session.status === 'succeeded' || operation.execution_started_at ? 'settled' : 'released';
    await finishCreditsInTransaction(db, operation.user_id, operationId, target);
    return target;
  });
}
export const settleCredits = (
  userId: string,
  operationId: string,
  outcome: 'success' | 'interrupted' = 'success',
) => finishCredits(userId, operationId, 'settled', outcome);
export const releaseCredits = (userId: string, operationId: string) =>
  finishCredits(userId, operationId, 'released');
export async function creditSummary(userId: string) {
  if (isCoworkBilling()) return (await import('./cowork-store')).coworkSummary(userId);
  const pool = await billingPool();
  const [balance, ledger, subscriptions, invoices, customer] = await Promise.all([
    pool.query(
      'SELECT COALESCE(sum(credits-used-reserved) FILTER(WHERE expires_at>now() AND NOT held),0) AS available,COALESCE(sum(reserved),0) AS reserved FROM edu_credit_buckets WHERE user_id=$1 AND livemode=$2',
      [userId, billingMode()],
    ),
    pool.query(
      'SELECT id,kind,credits,operation_id,created_at FROM edu_credit_ledger WHERE user_id=$1 AND livemode=$2 ORDER BY id DESC LIMIT 50',
      [userId, billingMode()],
    ),
    pool.query(
      'SELECT subscription_id,status,price_id,cancel_at_period_end,period_end FROM edu_billing_subscriptions WHERE user_id=$1 AND livemode=$2 ORDER BY updated_at DESC',
      [userId, billingMode()],
    ),
    pool.query(
      'SELECT invoice_id,amount,currency,credits,period_start,period_end FROM edu_billing_invoices WHERE user_id=$1 AND livemode=$2 ORDER BY created_at DESC LIMIT 30',
      [userId, billingMode()],
    ),
    pool.query(
      'SELECT payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
      [userId, billingMode()],
    ),
  ]);
  return {
    paymentReview: !!customer.rows[0]?.payment_review,
    available: Number(balance.rows[0].available),
    reserved: Number(balance.rows[0].reserved),
    ledger: ledger.rows,
    subscriptions: subscriptions.rows,
    invoices: invoices.rows,
  };
}
/** Only for a worker resuming the SAME durable task, never public request replay. */
export async function ensureRunReservation(
  userId: string,
  operationId: string,
  action: string,
): Promise<'reserved' | 'settled' | 'released'> {
  const pool = await billingPool();
  const find = async () => {
    const result = await pool.query(
      'SELECT user_id,action,state,livemode FROM edu_credit_operations WHERE id=$1',
      [operationId],
    );
    const row = result.rows[0];
    if (row && (row.user_id !== userId || row.action !== action || row.livemode !== billingMode()))
      throw new BillingError('operation_conflict', '任务归属不一致', 409);
    return row?.state as 'reserved' | 'settled' | 'released' | undefined;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    await reserveCredits(userId, operationId, action);
    return 'reserved';
  } catch (error) {
    if (error instanceof BillingError && error.code === 'operation_exists') {
      const state = await find();
      if (state) return state;
    }
    throw error;
  }
}
