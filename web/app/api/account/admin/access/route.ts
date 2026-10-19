import {accountAdminAccessRequest} from '@/lib/accounts/adminAccess';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return accountAdminAccessRequest(request);}
