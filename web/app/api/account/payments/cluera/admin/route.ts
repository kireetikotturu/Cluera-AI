import { clueraBillingAdminRequest } from '@/lib/payments/cluera/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return clueraBillingAdminRequest(request); }
export async function POST(request: Request) { return clueraBillingAdminRequest(request); }
