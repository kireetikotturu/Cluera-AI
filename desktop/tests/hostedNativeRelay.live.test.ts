import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { openStagingRelay } from '../src/main/accounts/StagingRelayClient';

// Credential-free real main-process client; no owner token, ledger or provider.
it.skipIf(process.env.SIGMAROUND_RUN_PUBLIC_RELAY_ACCEPTANCE !== 'true')(
  'hosted native transport receives terminal rejection and fails closed within its authorization deadline', async () => {
    const owner = new AbortController(), receive = vi.fn(), started = performance.now();
    let upgraded = false, terminal = false;
    try {
      await expect(openStagingRelay('invalid-synthetic-staging-probe', owner.signal, receive, (url, options) => {
        const peer = new WebSocket(url, options);
        peer.once('open', () => { upgraded = true; });
        peer.on('message', (data, binary) => { if (!binary && data.toString() === '{"type":"sessionEnded"}') terminal = true; });
        return peer;
      }))
        .rejects.toThrow(/^Account relay unavailable\.$/);
      expect(performance.now() - started).toBeLessThan(22000);
      expect(upgraded).toBe(true); expect(terminal).toBe(true);
      expect(receive).not.toHaveBeenCalled();
    } finally { owner.abort(); }
  }, 25000,
);
