import { handleClueraBillingHistory } from '@/lib/payments/cluera/history';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleClueraBillingHistory(request); }
