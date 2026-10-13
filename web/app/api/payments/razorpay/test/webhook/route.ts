import { handleRazorpayWebhook } from '../../../../../../lib/payments/webhooks/razorpay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleRazorpayWebhook(request); }
