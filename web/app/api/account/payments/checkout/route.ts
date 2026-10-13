import { handlePaymentCheckout } from '../../../../../lib/payments/checkout/handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handlePaymentCheckout;
export const POST = handlePaymentCheckout;
