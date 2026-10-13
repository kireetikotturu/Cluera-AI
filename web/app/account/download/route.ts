import {accountDistributionResponse} from '@/lib/accounts/releases';
export const dynamic = 'force-dynamic';
export const runtime='nodejs';
export const GET=()=>accountDistributionResponse(true);
