import {clueraAdminFinancialReportRequest} from '@/lib/payments/cluera/adminReports';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return clueraAdminFinancialReportRequest(request);}
