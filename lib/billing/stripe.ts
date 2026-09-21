import Stripe from 'stripe';
import { isBillingEnabled, billingOrigin, billingPlans, BillingError, billingMode } from './config';
import { billingTransaction, lockBillingUser } from './store';

export function stripeClient() {
  if (!isBillingEnabled() || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET)
    throw new BillingError('billing_unconfigured', '支付尚未配置，请稍后再试', 503);
  const key = process.env.STRIPE_SECRET_KEY!;
  const mode = process.env.EDU_BILLING_MODE || 'test';
  if (
    (mode === 'live' && !key.startsWith('sk_live_')) ||
    (mode === 'test' && !key.startsWith('sk_test_')) ||
    !['test', 'live'].includes(mode)
  )
    throw new BillingError('billing_mode_mismatch', '支付环境配置不一致', 503);
  return new Stripe(key, { maxNetworkRetries: 2 });
}
export async function createCheckout(
  userId: string,
  email: string,
  planId: string,
  expectedPriceId: string,
) {
  const stripe = stripeClient();
  const mode = billingMode();
  const plan = billingPlans().find((p) => p.id === planId);
  if (!plan) throw new BillingError('invalid_plan', '套餐不存在');
  if (plan.priceId !== expectedPriceId)
    throw new BillingError('catalog_changed', '套餐已更新，请刷新后重试', 409);
  const price = await stripe.prices.retrieve(plan.priceId);
  if (
    !price.active ||
    price.livemode !== (process.env.EDU_BILLING_MODE === 'live') ||
    price.unit_amount !== plan.amount ||
    price.currency !== plan.currency ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1
  )
    throw new BillingError('invalid_price', '套餐价格配置尚未就绪', 503);
  // Persist purchased terms before any external checkout can succeed.
  await billingTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'edu-contract:' + mode + ':' + plan.priceId,
    ]);
    const contract = (
      await db.query('SELECT * FROM edu_billing_contracts WHERE price_id=$1 AND livemode=$2', [
        plan.priceId,
        mode,
      ])
    ).rows[0];
    if (
      contract &&
      (Number(contract.credits) !== plan.credits ||
        Number(contract.amount) !== plan.amount ||
        contract.currency !== plan.currency)
    )
      throw new BillingError(
        'catalog_changed',
        '套餐权益已变更，请使用新的套餐价格后再开放购买',
        409,
      );
    await db.query(
      'INSERT INTO edu_billing_contracts(price_id,livemode,amount,currency,credits) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [plan.priceId, mode, plan.amount, plan.currency, plan.credits],
    );
  });
  const customerId = await billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const existing = await db.query(
      'SELECT customer_id,payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
      [userId, mode],
    );
    if (existing.rows[0]?.payment_review)
      throw new BillingError('payment_review', '付款正在核对，暂不能再次订阅', 409);
    let customerId = existing.rows[0]?.customer_id as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email, metadata: { edu_user_id: userId } },
        { idempotencyKey: 'edu-customer-' + mode + '-' + userId },
      );
      customerId = customer.id;
      await db.query(
        'INSERT INTO edu_billing_customers(user_id,customer_id,livemode) VALUES($1,$2,$3)',
        [userId, customerId, mode],
      );
    }
    return customerId;
  });
  return billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const review = (
      await db.query(
        'SELECT payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
        [userId, mode],
      )
    ).rows[0];
    if (review?.payment_review)
      throw new BillingError('payment_review', '付款正在核对，暂不能再次订阅', 409);
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    if (
      subscriptions.has_more ||
      subscriptions.data.some((s) => !['canceled', 'incomplete_expired'].includes(s.status))
    )
      throw new BillingError('subscription_exists', '已有订阅，请通过管理订阅查看', 409);
    const previous = await db.query(
      'SELECT * FROM edu_billing_checkouts WHERE user_id=$1 AND livemode=$2 FOR UPDATE',
      [userId, mode],
    );
    let generation = previous.rows[0]?.generation ?? 1;
    const old = previous.rows[0];
    if (old?.session_id) {
      const session = await stripe.checkout.sessions.retrieve(old.session_id);
      if (session.status === 'complete') {
        const sid =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        const prior = sid ? await stripe.subscriptions.retrieve(sid) : null;
        if (!prior || !['canceled', 'incomplete_expired'].includes(prior.status))
          throw new BillingError('payment_pending', '付款结果正在确认，请稍后刷新', 409);
      }
      if (session.status === 'open' && old.price_id === plan.priceId) return { url: session.url };
      if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
      generation += 1;
    } else if (old && old.price_id !== plan.priceId) generation += 1;
    await db.query(
      "INSERT INTO edu_billing_checkouts(user_id,generation,plan_id,price_id,livemode) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,livemode) DO UPDATE SET generation=$2,plan_id=$3,price_id=$4,state='pending',session_id=NULL,url=NULL",
      [userId, generation, plan.id, plan.priceId, mode],
    );
    // Recover a hosted session whose successful response was lost before local commit.
    const openSessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'open',
      limit: 100,
    });
    if (openSessions.has_more)
      throw new BillingError('checkout_review', '待确认付款过多，请稍后重试', 409);
    for (const open of openSessions.data) {
      if (open.metadata?.edu_user_id !== userId) continue;
      const lines = await stripe.checkout.sessions.listLineItems(open.id, { limit: 2 });
      if (lines.data.length === 1 && lines.data[0].price?.id === plan.priceId) {
        await db.query(
          "UPDATE edu_billing_checkouts SET session_id=$2,url=$3,state='open' WHERE user_id=$1 AND livemode=$4",
          [userId, open.id, open.url, mode],
        );
        return { url: open.url };
      }
      await stripe.checkout.sessions.expire(open.id);
    }
    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: 'subscription',
        branding_settings: { display_name: 'Zaokit Edu' },
        line_items: [{ price: plan.priceId, quantity: 1 }],
        success_url: billingOrigin() + '/account?checkout=success',
        cancel_url: billingOrigin() + '/account?checkout=cancel',
        client_reference_id: userId,
        metadata: { edu_user_id: userId },
        subscription_data: { metadata: { edu_user_id: userId } },
      },
      { idempotencyKey: `edu-checkout-${mode}-${userId}-${generation}-${plan.priceId}` },
    );
    await db.query(
      "UPDATE edu_billing_checkouts SET session_id=$2,url=$3,state='open' WHERE user_id=$1 AND livemode=$4",
      [userId, session.id, session.url, mode],
    );
    return { url: session.url };
  });
}
export async function createPortal(userId: string) {
  const stripe = stripeClient();
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
  if (!configuration) throw new BillingError('portal_unconfigured', '订阅管理尚未配置', 503);
  const config = await stripe.billingPortal.configurations.retrieve(configuration);
  if (
    config.features.subscription_update.enabled ||
    !config.features.subscription_cancel.enabled ||
    config.features.subscription_cancel.mode !== 'at_period_end'
  )
    throw new BillingError('unsafe_portal', '订阅管理配置尚未就绪', 503);
  return billingTransaction(async (db) => {
    const row = await db.query(
      'SELECT customer_id,payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
      [userId, billingMode()],
    );
    if (!row.rowCount) throw new BillingError('customer_missing', '尚无订阅记录', 404);
    const session = await stripe.billingPortal.sessions.create({
      customer: row.rows[0].customer_id,
      configuration,
      return_url: billingOrigin() + '/account',
    });
    return { url: session.url };
  });
}
