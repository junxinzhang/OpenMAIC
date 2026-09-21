import {
  COWORK_PLANS,
  CATALOG_VERSION,
  isCoworkBilling,
  MEDIA_COSTS,
  planPolicy,
} from '@/lib/billing/policy';
import { operationCost } from '@/lib/billing/config';
import { getRequestUser } from '@/lib/auth/session';
import { billingConfigured, billingPlans, isBillingEnabled } from '@/lib/billing/config';
import { creditSummary } from '@/lib/billing/store';
import { billingErrorResponse } from '@/lib/billing/guard';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    const user = await getRequestUser(req);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(
      {
        user,
        enabled: isBillingEnabled(),
        mode: process.env.EDU_BILLING_MODE === 'live' ? 'live' : 'test',
        configured: billingConfigured(),
        portalConfigured:
          !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PORTAL_CONFIGURATION_ID,
        catalogVersion: isCoworkBilling() ? CATALOG_VERSION : 'legacy',
        policy: isCoworkBilling() ? 'cowork_v1' : 'fixed',
        mediaCosts: Object.fromEntries(Object.keys(MEDIA_COSTS).map((k) => [k, operationCost(k)])),
        plans: billingPlans().length
          ? billingPlans().map((p) => ({ ...planPolicy(p.id), ...p }))
          : isCoworkBilling()
            ? COWORK_PLANS.map((p) => ({ ...p, priceId: null }))
            : [],
        ...(await creditSummary(user.id)),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return billingErrorResponse(error);
  }
}
