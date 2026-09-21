import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { billingConfigured, billingMode, billingPlans, BillingError } from './config';
import { stripeClient } from './stripe';
import { billingTransaction, lockBillingUser, billingPool } from './store';
import { applyStripeEvent } from './webhook';
const objectId = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value
      ? String(value.id)
      : undefined;

export async function upgradeSubscription(userId: string, planId: string, expectedPriceId: string) {
  if (!billingConfigured()) throw new BillingError('billing_unconfigured', '正式订阅尚未开放', 503);
  const plan = billingPlans().find((p) => p.id === planId);
  if (!plan || plan.priceId !== expectedPriceId)
    throw new BillingError('catalog_changed', '套餐已更新，请刷新后重试', 409);
  const stripe = stripeClient(),
    mode = billingMode();
  const price = await stripe.prices.retrieve(plan.priceId);
  if (
    !price.active ||
    price.livemode !== mode ||
    price.unit_amount !== plan.amount ||
    price.currency !== plan.currency ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1
  )
    throw new BillingError('invalid_price', '套餐价格尚未就绪', 503);
  const intent = await billingTransaction(async (db) => {
    await lockBillingUser(db, userId);
    const customer = (
      await db.query('SELECT * FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2', [
        userId,
        mode,
      ])
    ).rows[0];
    if (!customer || customer.payment_review)
      throw new BillingError('payment_review', '当前付款状态不支持升级', 409);
    const pending = (
      await db.query(
        "SELECT * FROM edu_billing_upgrades WHERE user_id=$1 AND livemode=$2 AND state='pending' ORDER BY created_at DESC LIMIT 1",
        [userId, mode],
      )
    ).rows[0];
    if (pending) {
      if (pending.price_id !== plan.priceId)
        throw new BillingError('upgrade_pending', '上一次升级正在确认，请稍后重试', 409);
      return { ...pending, customer_id: customer.customer_id };
    }
    const list = await stripe.subscriptions.list({
      customer: customer.customer_id,
      status: 'all',
      limit: 100,
    });
    const active = list.data.filter((s) => !['canceled', 'incomplete_expired'].includes(s.status));
    if (list.has_more || active.length !== 1 || active[0].status !== 'active')
      throw new BillingError('subscription_missing', '当前没有可升级的有效订阅', 409);
    const sub = active[0];
    if (
      sub.metadata.edu_user_id !== userId ||
      sub.livemode !== mode ||
      sub.items.data.length !== 1 ||
      sub.items.data[0].quantity !== 1 ||
      sub.discounts.length ||
      sub.automatic_tax.enabled ||
      sub.default_tax_rates?.length
    )
      throw new BillingError('invalid_subscription', '当前订阅需要先核对', 409);
    const before = (
      await db.query('SELECT * FROM edu_billing_contracts WHERE price_id=$1 AND livemode=$2', [
        sub.items.data[0].price.id,
        mode,
      ])
    ).rows[0];
    if (
      !before ||
      plan.amount <= Number(before.amount) ||
      plan.credits <= Number(before.credits) ||
      plan.currency !== before.currency
    )
      throw new BillingError('invalid_upgrade', '仅支持升级至金额和积分都更高的套餐', 409);
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
      (Number(contract.amount) !== plan.amount ||
        Number(contract.credits) !== plan.credits ||
        contract.currency !== plan.currency)
    )
      throw new BillingError('catalog_changed', '套餐权益已更新，请稍后重试', 409);
    await db.query(
      'INSERT INTO edu_billing_contracts(price_id,livemode,amount,currency,credits,plan_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [plan.priceId, mode, plan.amount, plan.currency, plan.credits, plan.id],
    );
    const id = randomUUID();
    await db.query(
      'INSERT INTO edu_billing_upgrades(id,user_id,subscription_id,price_id,previous_price_id,livemode) VALUES($1,$2,$3,$4,$5,$6)',
      [id, userId, sub.id, plan.priceId, sub.items.data[0].price.id, mode],
    );
    return {
      id,
      subscription_id: sub.id,
      price_id: plan.priceId,
      previous_price_id: sub.items.data[0].price.id,
      customer_id: customer.customer_id,
    };
  });
  let updated: Stripe.Subscription;
  try {
    updated = await billingTransaction(async (db) => {
      await lockBillingUser(db, userId);
      const sub = await stripe.subscriptions.retrieve(intent.subscription_id);
      if (
        sub.metadata.edu_user_id !== userId ||
        objectId(sub.customer) !== intent.customer_id ||
        sub.livemode !== mode ||
        sub.items.data.length !== 1 ||
        sub.status !== 'active'
      )
        throw new BillingError('invalid_subscription', '订阅状态发生变化，请刷新后重试', 409);
      if (sub.items.data[0].price.id === plan.priceId) return sub; // Recover a lost successful response without another charge.
      if (sub.items.data[0].price.id !== intent.previous_price_id)
        throw new BillingError('subscription_changed', '订阅套餐发生变化，请先核对', 409);
      return stripe.subscriptions.update(
        sub.id,
        {
          items: [{ id: sub.items.data[0].id, price: plan.priceId, quantity: 1 }],
          proration_behavior: 'none',
          billing_cycle_anchor: 'now',
          payment_behavior: 'error_if_incomplete',
          ...(sub.cancel_at_period_end
            ? { cancel_at_period_end: false }
            : sub.cancel_at
              ? { cancel_at: '' as const }
              : {}),
        },
        { idempotencyKey: 'edu-upgrade-' + intent.id },
      );
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'type' in error && error.type === 'StripeCardError') {
      await (
        await billingPool()
      ).query("UPDATE edu_billing_upgrades SET state='failed' WHERE id=$1", [intent.id]);
      throw new BillingError('payment_failed', '付款未成功，原套餐和积分保持不变', 402);
    }
    throw error;
  }
  const invoiceId = objectId(updated.latest_invoice);
  if (!invoiceId) throw new BillingError('upgrade_pending', '升级付款正在确认，请稍后刷新', 503);
  await applyStripeEvent({
    id: 'edu-upgrade:' + intent.id + ':' + invoiceId,
    type: 'invoice.paid',
    livemode: mode,
    data: { object: { id: invoiceId, customer: intent.customer_id } },
  } as unknown as Stripe.Event);
  return { upgraded: true, plan: plan.id };
}
