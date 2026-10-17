import { handleClueraWebhook } from '@/lib/payments/cluera/events';
import { after } from 'next/server';
import { wakeClueraBillingRelay } from '@/lib/payments/cluera/wakeRelay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleClueraWebhook(request, process.env, undefined, () => {
    after(async () => { await wakeClueraBillingRelay(); });
  });
}
