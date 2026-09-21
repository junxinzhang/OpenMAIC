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
        plans: billingPlans().map(({ priceId, ...plan }) => ({ ...plan, priceId })),
        ...(await creditSummary(user.id)),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return billingErrorResponse(error);
  }
}
