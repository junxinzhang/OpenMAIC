import { getRequestUser } from '@/lib/auth/session';
import { requireBillingOrigin } from '@/lib/billing/config';
import { createCheckout } from '@/lib/billing/stripe';
import { billingErrorResponse } from '@/lib/billing/guard';
export async function POST(req: Request) {
  try {
    requireBillingOrigin(req);
    const user = await getRequestUser(req);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await req.json();
    return Response.json(await createCheckout(user.id, user.email, body.plan, body.priceId));
  } catch (error) {
    return billingErrorResponse(error);
  }
}
