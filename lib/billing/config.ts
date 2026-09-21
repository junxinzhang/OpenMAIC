export interface BillingPlan {
  id: string;
  name: string;
  priceId: string;
  credits: number;
  amount: number;
  currency: string;
}
export function isBillingEnabled() {
  return process.env.EDU_BILLING_ENABLED === 'true';
}
export function billingPlans(): BillingPlan[] {
  const raw = process.env.EDU_BILLING_PLANS;
  if (!raw) return [];
  const plans: unknown = JSON.parse(raw);
  if (!Array.isArray(plans) || plans.length > 20) throw new Error('Invalid billing plans');
  const ids = new Set<string>();
  const prices = new Set<string>();
  return plans.map((p: BillingPlan) => {
    if (
      !p ||
      !/^[a-z0-9_-]{1,40}$/.test(p.id) ||
      ids.has(p.id) ||
      !/^price_/.test(p.priceId) ||
      prices.has(p.priceId) ||
      typeof p.name !== 'string' ||
      !p.name ||
      !Number.isSafeInteger(p.credits) ||
      p.credits <= 0 ||
      !Number.isSafeInteger(p.amount) ||
      p.amount <= 0 ||
      !/^[a-z]{3}$/.test(p.currency)
    )
      throw new Error('Invalid billing plan');
    ids.add(p.id);
    prices.add(p.priceId);
    return p;
  });
}
export function operationCost(action: string) {
  const values = JSON.parse(process.env.EDU_BILLING_ACTION_COSTS || '{}') as Record<string, number>;
  const cost = values[action] ?? values.default ?? 1;
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > 1_000_000)
    throw new Error('Invalid billing action cost');
  return cost;
}
export function billingOrigin() {
  const value = process.env.EDU_PUBLIC_ORIGIN;
  if (!value) throw new Error('EDU_PUBLIC_ORIGIN is required');
  return new URL(value).origin;
}
export function billingConfigured() {
  return (
    isBillingEnabled() &&
    !!process.env.STRIPE_SECRET_KEY &&
    !!process.env.STRIPE_WEBHOOK_SECRET &&
    billingPlans().length > 0
  );
}
export class BillingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireBillingOrigin(req: Request) {
  if (req.headers.get('origin') !== billingOrigin())
    throw new BillingError('invalid_origin', '请求来源无效', 403);
}

/** All pre-release rows belong to the sandbox, never to live billing. */
export function billingMode(): boolean {
  const mode = process.env.EDU_BILLING_MODE || 'test';
  if (!['test', 'live'].includes(mode))
    throw new BillingError('invalid_mode', '支付环境配置无效', 503);
  return mode === 'live';
}
