import {adminNativeCommandsRequest} from '@/lib/payments/cluera/adminNativeCommands';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return adminNativeCommandsRequest(request);}
