import { handleClueraCatalog } from '@/lib/payments/cluera/handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleClueraCatalog(request); }
