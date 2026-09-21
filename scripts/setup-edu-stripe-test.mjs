// Run with: node --env-file=.env.local scripts/setup-edu-stripe-test.mjs
// Creates only test-mode Edu objects; never modifies Cowork products or customers.
import Stripe from 'stripe';
import { readFile, writeFile, chmod } from 'node:fs/promises';
const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith('sk_test_')) throw new Error('A Stripe test key is required');
const stripe = new Stripe(key, { maxNetworkRetries: 2 });
const product = await stripe.products.create(
  {
    name: 'Zaokit Edu · Integration Test',
    description: 'Test-only monthly plan. Not a published commercial offer.',
    metadata: { app: 'zaokit-edu', purpose: 'integration-test' },
  },
  { idempotencyKey: 'zaokit-edu-integration-product-v1' },
);
const price = await stripe.prices.create(
  {
    product: product.id,
    currency: 'usd',
    unit_amount: 900,
    recurring: { interval: 'month' },
    metadata: { app: 'zaokit-edu', purpose: 'integration-test' },
  },
  { idempotencyKey: 'zaokit-edu-integration-price-v1' },
);
const portal = await stripe.billingPortal.configurations.create(
  {
    business_profile: { headline: 'Zaokit Edu 订阅管理（测试）' },
    features: {
      customer_update: { enabled: true, allowed_updates: ['name'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
    },
    metadata: { app: 'zaokit-edu', purpose: 'integration-test' },
  },
  { idempotencyKey: 'zaokit-edu-integration-portal-v1' },
);
const settings = {
  EDU_BILLING_ENABLED: 'true',
  EDU_BILLING_MODE: 'test',
  EDU_BILLING_PLANS: JSON.stringify([
    {
      id: 'edu-test',
      name: 'Edu 测试套餐',
      priceId: price.id,
      credits: 1000,
      amount: 900,
      currency: 'usd',
    },
  ]),
  EDU_BILLING_ACTION_COSTS: JSON.stringify({
    default: 1,
    course_generate: 20,
    'agent.message': 5,
    model_request: 1,
    image_generate: 5,
    video_generate: 20,
    tts_generate: 1,
    transcription: 1,
    document_extract: 2,
    web_search: 1,
    video_render: 10,
  }),
  STRIPE_PORTAL_CONFIGURATION_ID: portal.id,
};
let lines = (await readFile('.env.local', 'utf8')).split('\n');
for (const [name, value] of Object.entries(settings)) {
  lines = lines.filter((line) => !line.startsWith(name + '='));
  lines.push(
    `${name}=${(typeof value === 'string' && value.startsWith('{')) || value.startsWith('[') ? `'${value}'` : value}`,
  );
}
await writeFile('.env.local', lines.filter(Boolean).join('\n') + '\n');
await chmod('.env.local', 0o600);
console.log(
  JSON.stringify({
    mode: 'test',
    product: product.id,
    price: price.id,
    portal: portal.id,
    credits: 1000,
  }),
);
