import { getRequestUser } from '@/lib/auth/session';
import { requireBillingOrigin } from '@/lib/billing/config';
import { createPortal } from '@/lib/billing/stripe';
import { billingErrorResponse } from '@/lib/billing/guard';
export async function POST(req: Request) {
  try {
    requireBillingOrigin(req);
    const user = await getRequestUser(req);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(await createPortal(user.id));
  } catch (error) {
    return billingErrorResponse(error);
  }
}
