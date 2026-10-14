import { handleClueraCheckout } from '@/lib/payments/cluera/handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleClueraCheckout(request); }
export async function POST(request: Request) { return handleClueraCheckout(request); }
