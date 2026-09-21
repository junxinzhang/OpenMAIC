import { stripeClient } from '@/lib/billing/stripe';
import { applyStripeEvent } from '@/lib/billing/webhook';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  if (Number(req.headers.get('content-length') || 0) > 1_048_576)
    return new Response('Payload too large', { status: 413 });
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });
  let stripe;
  try {
    stripe = stripeClient();
  } catch {
    return new Response('Billing not configured', { status: 503 });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (!reader) return new Response('Missing body', { status: 400 });
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      return new Response('Payload too large', { status: 413 });
    }
    chunks.push(chunk.value);
  }
  const raw = Buffer.concat(chunks);
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET!, 300);
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }
  try {
    await applyStripeEvent(event);
    console.info(
      '[billing-webhook] accepted',
      event.id,
      event.type,
      event.livemode ? 'live' : 'test',
    );
    return Response.json({ received: true });
  } catch (error) {
    console.error(
      '[billing] webhook processing failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return new Response('Please retry', { status: 503 });
  }
}
