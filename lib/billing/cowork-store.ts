import type { PoolClient } from 'pg';
import { billingMode, BillingError, operationCost } from './config';
import { billingTransaction, lockBillingUser } from './store';
import { METERED_ACTIONS, TASK_ACTIONS, planPolicy, weightedCredits } from './policy';

export async function ensureTrial(db: PoolClient, userId: string) {
  const inserted = await db.query(
    `INSERT INTO edu_credit_buckets(id,user_id,credits,expires_at,livemode,plan_id)
     VALUES($1,$2,200,'9999-12-31',$3,'trial') ON CONFLICT DO NOTHING RETURNING id`,
    [`trial:${billingMode() ? 'live' : 'test'}:${userId}`, userId, billingMode()],
  );
  if (inserted.rowCount)
    await db.query(
      "INSERT INTO edu_credit_ledger(user_id,kind,credits,livemode) VALUES($1,'trial_grant',200,$2)",
      [userId, billingMode()],
    );
}
export async function currentBucket(db: PoolClient, userId: string) {
  await ensureTrial(db, userId);
  return (
    await db.query(
      `SELECT *,expires_at>now() AS active FROM edu_credit_buckets
     WHERE user_id=$1 AND livemode=$2
     ORDER BY (subscription_id IS NOT NULL) DESC,expires_at DESC,credits DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [userId, billingMode()],
    )
  ).rows[0];
}
export async function reserveCoworkCredits(userId: string, id: string, action: string) {
  if (!id || id.length > 200) throw new BillingError('invalid_operation', '任务标识无效');
  return billingTransaction(async (db) => {
    // One global admission lock makes the eight-worker limit atomic across users.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['edu-cowork-admission']);
    await lockBillingUser(db, userId);
    if ((await db.query('SELECT id FROM edu_credit_operations WHERE id=$1', [id])).rowCount)
      throw new BillingError('operation_exists', '该请求已处理，请查看原任务', 409);
    const bucket = await currentBucket(db, userId);
    const policy = planPolicy(bucket.plan_id);
    if (!bucket.active || bucket.held)
      throw new BillingError('entitlement_expired', '当前额度已到期或付款正在核对', 402);
    const available = Number(bucket.credits) - Number(bucket.used) - Number(bucket.reserved);
    if (available <= 0)
      throw Number(bucket.reserved) > 0
        ? new BillingError('credits_reserved', '额度正在被当前任务预留，请稍后再试', 429)
        : new BillingError('insufficient_credits', '积分不足，请前往账户页面升级套餐', 402);
    // Course/Agent starts are user tasks. Internal model and media requests do not
    // become additional hourly/daily course starts merely because a course has many pages.
    if (TASK_ACTIONS.has(action)) {
      const counts = (
        await db.query(
          `SELECT count(*) FILTER(WHERE state='reserved' AND execution_outcome IS NULL)::int AS running,
          count(*) FILTER(WHERE created_at>now()-interval '1 hour')::int AS hourly,
          count(*) FILTER(WHERE created_at>now()-interval '1 day')::int AS daily
         FROM edu_credit_operations WHERE user_id=$1 AND livemode=$2
          AND billing_policy='cowork_v1' AND action IN ('course_generate','agent.message')`,
          [userId, billingMode()],
        )
      ).rows[0];
      if (counts.running >= policy.concurrent)
        throw new BillingError('concurrency_limit', '当前套餐的任务正在运行，请完成后重试', 429);
      if (counts.hourly >= policy.hourly || counts.daily >= policy.daily)
        throw new BillingError('start_rate_limit', '本小时或今日任务次数已用完，请稍后重试', 429);
    }
    const global = (
      await db.query(
        `SELECT count(*)::int AS n FROM edu_credit_operations WHERE state='reserved'
         AND execution_outcome IS NULL AND billing_policy='cowork_v1'
         AND livemode=$1`,
        [billingMode()],
      )
    ).rows[0];
    if (global.n >= 8) throw new BillingError('host_capacity', '当前生成任务较多，请稍后重试', 429);
    const amount = METERED_ACTIONS.has(action) ? Math.min(500, available) : operationCost(action);
    if (amount > available)
      throw new BillingError('insufficient_credits', '积分不足，请前往账户页面升级套餐', 402);
    await db.query(
      `INSERT INTO edu_credit_operations(id,user_id,action,cost,state,livemode,billing_policy,plan_id)
       VALUES($1,$2,$3,$4,'reserved',$5,'cowork_v1',$6)`,
      [id, userId, action, amount, billingMode(), bucket.plan_id],
    );
    await db.query('UPDATE edu_credit_buckets SET reserved=reserved+$2 WHERE id=$1', [
      bucket.id,
      amount,
    ]);
    await db.query('INSERT INTO edu_credit_allocations VALUES($1,$2,$3)', [id, bucket.id, amount]);
    await db.query(
      "INSERT INTO edu_credit_ledger(user_id,operation_id,kind,credits,livemode) VALUES($1,$2,'reserve',$3,$4)",
      [userId, id, -amount, billingMode()],
    );
  });
}

export async function finishCoworkCredits(
  userId: string,
  id: string,
  outcome: 'success' | 'interrupted' | 'failed',
) {
  // Terminal evidence frees execution capacity even when token totals are missing.
  await billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const op = (
      await db.query('SELECT * FROM edu_credit_operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        id,
        userId,
      ])
    ).rows[0];
    if (!op) throw new BillingError('operation_missing', '任务记录不存在', 404);
    if (op.execution_outcome && op.execution_outcome !== outcome)
      throw new BillingError('operation_finalized', '任务结果已经确认', 409);
    await db.query('UPDATE edu_credit_operations SET execution_outcome=$2 WHERE id=$1', [
      id,
      outcome,
    ]);
  });
  return billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const op = (
      await db.query('SELECT * FROM edu_credit_operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        id,
        userId,
      ])
    ).rows[0];
    if (op.state !== 'reserved') return;
    let input = 0,
      output = 0,
      charge = 0;
    if (outcome !== 'failed') {
      if (METERED_ACTIONS.has(op.action)) {
        const calls = (
          await db.query('SELECT * FROM edu_credit_model_calls WHERE operation_id=$1', [id])
        ).rows;
        const media = (
          await db.query(
            'SELECT COALESCE(sum(credits),0)::int AS credits,count(*)::int AS n FROM edu_credit_media_calls WHERE operation_id=$1',
            [id],
          )
        ).rows[0];
        if (
          (!calls.length && !media.n) ||
          calls.some(
            (c) => c.input_tokens === null || c.output_tokens === null || c.state !== 'complete',
          )
        )
          return;
        input = calls.reduce((n, c) => n + Number(c.input_tokens), 0);
        output = calls.reduce((n, c) => n + Number(c.output_tokens), 0);
        charge = Math.min(Number(op.cost), weightedCredits(input, output) + media.credits);
      } else charge = Number(op.cost);
    }
    const allocations = (
      await db.query('SELECT * FROM edu_credit_allocations WHERE operation_id=$1', [id])
    ).rows;
    let remaining = charge;
    for (const row of allocations) {
      const take = Math.min(remaining, Number(row.credits));
      remaining -= take;
      await db.query(
        'UPDATE edu_credit_buckets SET reserved=reserved-$2,used=used+$3 WHERE id=$1',
        [row.bucket_id, row.credits, take],
      );
    }
    await db.query(
      `UPDATE edu_credit_operations SET state=$2,charged=$3,input_tokens=$4,output_tokens=$5,finished_at=now() WHERE id=$1`,
      [id, outcome === 'failed' ? 'released' : 'settled', charge, input, output],
    );
    await db.query(
      "INSERT INTO edu_credit_ledger(user_id,operation_id,kind,credits,livemode) VALUES($1,$2,'charge',$3,$4)",
      [userId, id, -charge, op.livemode],
    );
    const released = Number(op.cost) - charge;
    if (released)
      await db.query(
        "INSERT INTO edu_credit_ledger(user_id,operation_id,kind,credits,livemode) VALUES($1,$2,'released',$3,$4)",
        [userId, id, released, op.livemode],
      );
  });
}
export async function coworkSummary(userId: string) {
  return billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const bucket = await currentBucket(db, userId);
    const [ledger, subscriptions, invoices, customer, operations] = await Promise.all([
      db.query(
        'SELECT id,kind,credits,operation_id,created_at FROM edu_credit_ledger WHERE user_id=$1 AND livemode=$2 ORDER BY id DESC LIMIT 50',
        [userId, billingMode()],
      ),
      db.query(
        `SELECT s.*,c.amount,c.currency,c.credits,c.plan_id FROM edu_billing_subscriptions s LEFT JOIN edu_billing_contracts c ON c.price_id=s.price_id AND c.livemode=s.livemode WHERE s.user_id=$1 AND s.livemode=$2 ORDER BY s.updated_at DESC`,
        [userId, billingMode()],
      ),
      db.query(
        'SELECT * FROM edu_billing_invoices WHERE user_id=$1 AND livemode=$2 ORDER BY created_at DESC LIMIT 30',
        [userId, billingMode()],
      ),
      db.query(
        'SELECT payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
        [userId, billingMode()],
      ),
      db.query(
        'SELECT id,action,state,cost,charged,input_tokens,output_tokens,execution_outcome,created_at,finished_at FROM edu_credit_operations WHERE user_id=$1 AND livemode=$2 ORDER BY created_at DESC LIMIT 50',
        [userId, billingMode()],
      ),
    ]);
    const policy = planPolicy(bucket.plan_id);
    return {
      paymentReview: !!customer.rows[0]?.payment_review,
      available:
        bucket.active && !bucket.held
          ? Math.max(0, Number(bucket.credits) - Number(bucket.used) - Number(bucket.reserved))
          : 0,
      reserved: Number(bucket.reserved),
      used: Number(bucket.used),
      limit: Number(bucket.credits),
      plan: bucket.plan_id,
      planName: bucket.plan_id === 'legacy' ? '历史套餐' : policy.name,
      periodEnd: bucket.plan_id === 'trial' ? null : bucket.expires_at,
      limits: { concurrent: policy.concurrent, hourly: policy.hourly, daily: policy.daily },
      ledger: ledger.rows,
      subscriptions: subscriptions.rows,
      invoices: invoices.rows,
      operations: operations.rows,
    };
  });
}
