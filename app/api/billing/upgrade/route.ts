import { getRequestUser } from '@/lib/auth/session';
import { requireBillingOrigin, BillingError } from '@/lib/billing/config';
import { CATALOG_VERSION } from '@/lib/billing/policy';
import { upgradeSubscription } from '@/lib/billing/upgrade';
import { billingErrorResponse } from '@/lib/billing/guard';
export async function POST(req: Request) {
  try {
    requireBillingOrigin(req);
    const user = await getRequestUser(req);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await req.json();
    if (body.catalogVersion !== CATALOG_VERSION)
      throw new BillingError('catalog_changed', '套餐已更新，请刷新后重试', 409);
    return Response.json(await upgradeSubscription(user.id, body.plan, body.priceId));
  } catch (error) {
    return billingErrorResponse(error);
  }
}
