import {accountDistributionResponse} from '@/lib/accounts/releases';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET():Promise<Response>{return accountDistributionResponse(true);}
