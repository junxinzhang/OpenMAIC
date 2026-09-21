import type Stripe from 'stripe';
import { stripeClient } from './stripe';
import { BillingError, billingMode } from './config';
import { billingTransaction, lockBillingUser } from './store';
const relevant = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
]);
const objectId = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value
      ? String(value.id)
      : undefined;
export async function applyStripeEvent(event: Stripe.Event) {
  if (event.livemode !== billingMode()) throw new BillingError('wrong_mode', 'Wrong Stripe mode');
  if (!relevant.has(event.type)) return;
  const stripe = stripeClient();
  const obj = event.data.object as unknown as Record<string, unknown>;
  let customerId = objectId(obj.customer);
  if (event.type === 'charge.dispute.created' && !customerId) {
    const chargeId = objectId(obj.charge);
    if (chargeId) customerId = objectId((await stripe.charges.retrieve(chargeId)).customer);
  }
  if (!customerId) return;
  await billingTransaction(async (db) => {
    const customer = await db.query(
      'SELECT user_id,payment_review FROM edu_billing_customers WHERE customer_id=$1 AND livemode=$2',
      [customerId, event.livemode],
    );
    if (!customer.rowCount) return;
    const userId = customer.rows[0].user_id;
    await lockBillingUser(db, userId);
    const review = (
      await db.query(
        'SELECT payment_review FROM edu_billing_customers WHERE user_id=$1 AND livemode=$2',
        [userId, event.livemode],
      )
    ).rows[0]?.payment_review;
    if (
      (await db.query('SELECT event_id FROM edu_billing_events WHERE event_id=$1', [event.id]))
        .rowCount
    )
      return;
    let subscriptionId: string | undefined;
    let invoice: Stripe.Invoice | undefined;
    if (event.type.startsWith('invoice.')) {
      invoice = await stripe.invoices.retrieve(String(obj.id));
      subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
    } else if (event.type.startsWith('customer.subscription.')) subscriptionId = String(obj.id);
    else if (event.type === 'checkout.session.completed') {
      const checkout = await stripe.checkout.sessions.retrieve(String(obj.id));
      subscriptionId = objectId(checkout.subscription);
      await db.query(
        "UPDATE edu_billing_checkouts SET state='complete' WHERE user_id=$1 AND session_id=$2 AND livemode=$3",
        [userId, checkout.id, event.livemode],
      );
    } else {
      // Stop future collection before freezing funds. A failed Stripe update is retried.
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      if (subscriptions.has_more)
        throw new BillingError('review_incomplete', 'Subscription review needs pagination');
      for (const sub of subscriptions.data) {
        if (
          sub.metadata.edu_user_id !== userId ||
          ['canceled', 'incomplete_expired'].includes(sub.status)
        )
          continue;
        await stripe.subscriptions.update(
          sub.id,
          { pause_collection: { behavior: 'void' }, cancel_at_period_end: true },
          { idempotencyKey: `edu-review-${event.id}-${sub.id}` },
        );
      }
      await db.query(
        'UPDATE edu_billing_customers SET payment_review=true WHERE user_id=$1 AND livemode=$2',
        [userId, event.livemode],
      );
      // Hold credits without destroying their actual paid validity period.
      await db.query(
        'UPDATE edu_credit_buckets SET held=true WHERE user_id=$1 AND livemode=$2 AND subscription_id IS NOT NULL',
        [userId, event.livemode],
      );
      await db.query(
        "INSERT INTO edu_credit_ledger(user_id,kind,credits,livemode) VALUES($1,'payment_review',0,$2)",
        [userId, event.livemode],
      );
    }
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (
        objectId(sub.customer) !== customerId ||
        sub.metadata.edu_user_id !== userId ||
        sub.items.data.length !== 1
      )
        throw new BillingError('invalid_subscription', 'Subscription binding mismatch');
      const item = sub.items.data[0];
      const contract = (
        await db.query('SELECT * FROM edu_billing_contracts WHERE price_id=$1 AND livemode=$2', [
          item.price.id,
          event.livemode,
        ])
      ).rows[0];
      const plan = contract && {
        priceId: contract.price_id,
        amount: Number(contract.amount),
        currency: contract.currency,
        credits: Number(contract.credits),
      };
      if (!plan) throw new BillingError('unknown_price', 'Unrecognized subscription price');
      await db.query(
        `INSERT INTO edu_billing_subscriptions(subscription_id,user_id,customer_id,status,price_id,cancel_at_period_end,period_end,livemode) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),$8) ON CONFLICT(subscription_id) DO UPDATE SET status=$4,price_id=$5,cancel_at_period_end=$6,period_end=to_timestamp($7),updated_at=now()`,
        [
          sub.id,
          userId,
          customerId,
          sub.status,
          item.price.id,
          sub.cancel_at_period_end || sub.cancel_at === item.current_period_end,
          item.current_period_end,
          event.livemode,
        ],
      );
      if (['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(sub.status))
        await db.query(
          'UPDATE edu_credit_buckets SET expires_at=LEAST(expires_at,now()) WHERE subscription_id=$1',
          [sub.id],
        );
      if (event.type === 'invoice.paid' && invoice) {
        const lines = invoice.lines.data.filter(
          (line) => line.pricing?.price_details?.price === plan.priceId,
        );
        if (
          invoice.status !== 'paid' ||
          invoice.livemode !== event.livemode ||
          objectId(invoice.customer) !== customerId ||
          invoice.amount_paid !== plan.amount ||
          invoice.currency !== plan.currency ||
          invoice.lines.has_more ||
          lines.length !== 1 ||
          invoice.lines.data.length !== 1 ||
          !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason || '')
        )
          throw new BillingError('invalid_invoice', 'Invoice does not match monthly contract');
        const line = lines[0];
        if (
          line.quantity !== 1 ||
          line.amount !== plan.amount ||
          line.period.end <= line.period.start
        )
          throw new BillingError('invalid_invoice', 'Invalid invoice line');
        const inserted = await db.query(
          'INSERT INTO edu_billing_invoices(invoice_id,user_id,subscription_id,amount,currency,credits,period_start,period_end,livemode) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),$9) ON CONFLICT(invoice_id) DO NOTHING RETURNING invoice_id',
          [
            invoice.id,
            userId,
            sub.id,
            invoice.amount_paid,
            invoice.currency,
            plan.credits,
            line.period.start,
            line.period.end,
            event.livemode,
          ],
        );
        if (inserted.rowCount) {
          await db.query(
            'INSERT INTO edu_credit_buckets(id,user_id,subscription_id,credits,expires_at,livemode,held) VALUES($1,$2,$3,$4,to_timestamp($5),$6,$7)',
            [
              'invoice:' + invoice.id,
              userId,
              sub.id,
              plan.credits,
              ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(sub.status)
                ? Math.min(line.period.end, Math.floor(Date.now() / 1000))
                : line.period.end,
              event.livemode,
              !!review,
            ],
          );
          await db.query(
            "INSERT INTO edu_credit_ledger(user_id,kind,credits,operation_id,livemode) VALUES($1,'grant',$2,$3,$4)",
            [userId, plan.credits, invoice.id, event.livemode],
          );
        }
      }
    }
    await db.query('INSERT INTO edu_billing_events(event_id) VALUES($1)', [event.id]);
  });
}
