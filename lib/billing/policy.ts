/** Cowork three_tier_v1 / wallet tariff v1, adapted to Edu's independent ledger. */
export const CATALOG_VERSION = 'three_tier_v1';
export const COWORK_PLANS = [
  {
    id: 'plus',
    name: 'Plus',
    amount: 2000,
    currency: 'usd',
    credits: 5000,
    concurrent: 1,
    hourly: 12,
    daily: 60,
  },
  {
    id: 'pro',
    name: 'Pro',
    amount: 10000,
    currency: 'usd',
    credits: 25000,
    concurrent: 3,
    hourly: 24,
    daily: 120,
  },
  {
    id: 'max',
    name: 'Max',
    amount: 20000,
    currency: 'usd',
    credits: 100000,
    concurrent: 3,
    hourly: 24,
    daily: 120,
  },
] as const;
export const TRIAL_POLICY = {
  id: 'trial',
  name: '免费试用',
  credits: 200,
  concurrent: 1,
  hourly: 6,
  daily: 12,
};
export function isCoworkBilling() {
  return process.env.EDU_BILLING_POLICY === 'cowork_v1';
}
export function planPolicy(id: string) {
  return COWORK_PLANS.find((p) => p.id === id) ?? (id === 'trial' ? TRIAL_POLICY : COWORK_PLANS[0]);
}
export function weightedCredits(input: number, output: number) {
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1e12))
    throw new Error('Invalid token usage');
  return Math.ceil((input + 4 * output) / 1000);
}
export function modelTier(model: string): 'auto' | 'pro' {
  const id = model.split(':').pop()!.toLowerCase();
  return /^(gpt-5\.(4-mini|5|6-terra|6-luna)|grok-4\.6|auto)(-|$)/.test(id) ? 'auto' : 'pro';
}
export const METERED_ACTIONS = new Set(['model_request', 'course_generate', 'agent.message']);
export const TASK_ACTIONS = new Set(['course_generate', 'agent.message']);

export const MEDIA_COSTS: Record<string, number> = {
  image_generate: 5,
  video_generate: 20,
  tts_generate: 1,
  transcription: 1,
  document_extract: 2,
  web_search: 1,
  video_render: 10,
};
