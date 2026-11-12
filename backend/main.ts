import { relayConfig } from '../web/lib/accountRelay/config';
import { authorizeRelay } from '../web/lib/accountRelay/authorization';
import { approvedProviders } from '../web/lib/accountRelay/approvedProviders';
import { createRelayServer } from '../web/lib/accountRelay/server';
import { relayDatabaseAuthenticated } from '../web/lib/accountRelay/infrastructureCheck';
import { createRenderBillingTransport } from './billingTransport';
import { createLiveBillingTransport } from './liveBillingTransport';

// Deliberately no dotenv/file discovery: inject rotated staging secrets at runtime.
try {
  const config = relayConfig();
  // A mistake in the Live payment worker settings must never take the AI relay
  // down for every customer. The worker stays off and the reason is logged.
  const liveBilling = (() => {
    try {
      return createLiveBillingTransport(process.env, {
        observe: event => console.info(JSON.stringify({ component: 'cluera-live-billing-dispatch', event })),
      });
    } catch {
      console.error('{"component":"cluera-live-billing-dispatch","event":"configuration_unavailable"}');
      return { start() {}, async stop() {} };
    }
  })();
  const billing = createRenderBillingTransport({database:config.database,site:config.site},process.env,{
    observe:event=>console.info(JSON.stringify({component:'cluera-billing-dispatch',event})),
  });
  const relay = createRelayServer({ authorize: token => authorizeRelay(token, config),
    providers: approvedProviders(config),
    observe: event => console.info(JSON.stringify({ component: 'account-relay', event })),
    internalRequest:billing.handleRequest,
  },process.env.RENDER_GIT_COMMIT,config,()=>relayDatabaseAuthenticated(config));
  relay.server.on('error', () => { console.error('{"component":"account-relay","event":"listener_failed"}'); process.exitCode = 1; });
  relay.server.listen(config.port, '0.0.0.0',()=>{ billing.start(); liveBilling.start(); });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return; stopping = true;
    // STOP RPCs have an 8s transport limit. Let them settle after sockets close;
    // crash/unknown results still expire through the 30s database reservation.
    const bound = setTimeout(() => process.exit(0), 10000); bound.unref();
    // Stop timer/abort dispatch synchronously before closing existing AI sessions.
    const billingStopped=billing.stop();
    void Promise.all([billingStopped,liveBilling.stop(),relay.stop()]).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} catch {
  console.error('{"component":"account-relay","event":"configuration_unavailable"}'); process.exitCode = 1;
}
