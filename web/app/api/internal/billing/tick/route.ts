import {handleBillingTick} from '../../../../../lib/billing/reconciliation/runner';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=180;
export async function POST(request:Request){return handleBillingTick(request);}
