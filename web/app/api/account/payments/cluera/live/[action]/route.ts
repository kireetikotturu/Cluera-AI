import { handleLiveBilling, type LiveBillingAction } from '@/lib/payments/cluera/liveRoutes';
import { handleLiveWebhook } from '@/lib/payments/cluera/liveWorker';
import { clueraBillingAdminRequest } from '@/lib/payments/cluera/admin';
import { clueraPlanAdminRequest } from '@/lib/payments/cluera/adminPlans';
import { wakeClueraBillingRelay } from '@/lib/payments/cluera/wakeRelay';
import { after } from 'next/server';
import { clueraAdminFinancialReportRequest } from '@/lib/payments/cluera/adminReports';
import { createLiveBillingScope } from '@/lib/payments/cluera/modeProfile';
import { json } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actions: LiveBillingAction[] = ['catalog', 'checkout', 'callback', 'resume', 'history', 'cancellation'];
async function route(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (action === 'admin' || action === 'report' || action === 'plans') {
    if (process.env.CLUERA_LIVE_ADMIN_ENABLED !== 'true') return json({error:'Not found.'},404);
    try {
      const env=createLiveBillingScope();
      return action==='admin'?clueraBillingAdminRequest(request,env):action==='plans'?clueraPlanAdminRequest(request,env):clueraAdminFinancialReportRequest(request,env);
    } catch { return json({error:'Billing administration unavailable.'},503); }
  }
  if (action === 'webhook' && request.method === 'POST') {
    // A durably stored receipt wakes the (possibly sleeping) Render worker, exactly like the Test receiver.
    return handleLiveWebhook(request, process.env, undefined, () => {
      after(async () => { try { await wakeClueraBillingRelay(createLiveBillingScope()); } catch { /* The relay's own timer still catches up. */ } });
    });
  }
  if (!actions.includes(action as LiveBillingAction)) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return handleLiveBilling(request, action as LiveBillingAction);
}
export { route as GET, route as POST };
