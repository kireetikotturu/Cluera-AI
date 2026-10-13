import { relayConfig } from '../web/lib/accountRelay/config';
import { authorizeRelay } from '../web/lib/accountRelay/authorization';
import { approvedProviders } from '../web/lib/accountRelay/approvedProviders';
import { createRelayServer } from '../web/lib/accountRelay/server';

// Deliberately no dotenv/file discovery: inject rotated staging secrets at runtime.
try {
  const config = relayConfig();
  const relay = createRelayServer({ authorize: token => authorizeRelay(token, config),
    providers: approvedProviders(config),
    observe: event => console.info(JSON.stringify({ component: 'account-relay', event })),
  },process.env.RENDER_GIT_COMMIT,config);
  relay.server.on('error', () => { console.error('{"component":"account-relay","event":"listener_failed"}'); process.exitCode = 1; });
  relay.server.listen(config.port, '0.0.0.0');
  let stopping = false;
  const shutdown = () => {
    if (stopping) return; stopping = true;
    // STOP RPCs have an 8s transport limit. Let them settle after sockets close;
    // crash/unknown results still expire through the 30s database reservation.
    const bound = setTimeout(() => process.exit(0), 10000); bound.unref();
    void relay.stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} catch {
  console.error('{"component":"account-relay","event":"configuration_unavailable"}'); process.exitCode = 1;
}
