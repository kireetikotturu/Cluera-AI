import { handleClueraWebhook } from '@/lib/payments/cluera/events';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleClueraWebhook(request); }
