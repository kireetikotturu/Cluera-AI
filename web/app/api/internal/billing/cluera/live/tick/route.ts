import { handleLiveTick } from '@/lib/payments/cluera/liveWorker';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
export async function POST(request: Request) { return handleLiveTick(request); }
