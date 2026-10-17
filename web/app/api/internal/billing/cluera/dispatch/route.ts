import { handleClueraExternalDispatch } from '../../../../../../lib/payments/cluera/externalScheduler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
export async function POST(request: Request) { return handleClueraExternalDispatch(request); }
