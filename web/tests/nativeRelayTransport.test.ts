import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { openStagingRelay, type RelayOutput } from '../../desktop/src/main/accounts/StagingRelayClient';
import { createRelayServer } from '../lib/accountRelay/server';
import { createUsageCoordinator } from '../lib/usage/coordinator';

// Real loopback socket + production protocol on both sides; synthetic account,
// ledger and providers. No hosted credential, database mutation or provider spend.
it('native transport shares one server run for audio and answers, and ends it on owner logout', async () => {
  type Command = Parameters<Parameters<typeof createUsageCoordinator>[0]>[0];
  const command = vi.fn(async (input: Command) => input.action === 'STOP' ? { code: 'CLOSED' as const } : {
    code: 'ACTIVE' as const, runId: input.runId, sequence: input.sequence, serverTime: '2026-10-04T00:00:00Z',
    expiresAt: '2026-10-04T00:00:30Z', reservedMilliseconds: 30000, validForMilliseconds: 30000, allocation: 'TRIAL' as const,
  });
  const closed = Promise.withResolvers<void>(), audioClosed = vi.fn();
  const relay = createRelayServer({
    authorize: async () => ({ remainingTokenMs: 3600000, createRun: () => createUsageCoordinator(command) }),
    providers: {
      generate: async (_input, guard, emit) => { guard.assertActive(); emit('synthetic answer'); },
      audio: (_guard, emit, _failed, ready) => {
        queueMicrotask(() => ready?.());
        return { write: () => emit({ event: 'EndOfTurn', transcript: 'synthetic transcript' }),
          forceEndTurn: () => {}, close: audioClosed };
      },
    }, observe: event => { if (event === 'socket_closed') closed.resolve(); },
  });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const port = (relay.server.address() as { port: number }).port;
  const owner = new AbortController(), messages: RelayOutput[] = [];
  const audioReady = Promise.withResolvers<void>(), answered = Promise.withResolvers<void>(), transcript = Promise.withResolvers<void>();
  try {
    const client = await openStagingRelay('synthetic-account-access-token', owner.signal, event => {
      messages.push(event);
      if (event.type === 'audioReady') audioReady.resolve();
      if (event.type === 'answerDone') answered.resolve();
      if (event.type === 'transcript') transcript.resolve();
    }, (_fixedStagingUrl, options) => new WebSocket(`ws://127.0.0.1:${port}/v1/session`, options));
    expect(command).not.toHaveBeenCalled();
    client.send({ type: 'openAudio', channel: 'interviewer' }); await audioReady.promise;
    client.writeAudio('interviewer', Buffer.from([0, 0])); await transcript.promise;
    client.send({ type: 'generate', id: 'one', prompt: 'synthetic' }); await answered.promise;
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(['START']);
    expect(messages).toContainEqual({ type: 'answer', id: 'one', text: 'synthetic answer' });
    owner.abort(); expect(client.signal.aborted).toBe(true); await closed.promise;
    expect(audioClosed).toHaveBeenCalledOnce();
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(['START', 'STOP']);
    expect(command.mock.calls[0][0].runId).toBe(command.mock.calls[1][0].runId);
  } finally { owner.abort(); await relay.stop(); }
}, 10000);

it('native transport sees actual authorization rejection without starting usage or providers', async () => {
  const audio = vi.fn(), generate = vi.fn(), receive = vi.fn();
  const relay = createRelayServer({ authorize: async () => { throw Error('synthetic private failure'); }, providers: { audio, generate } });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const port = (relay.server.address() as { port: number }).port;
  try {
    await expect(openStagingRelay('synthetic-account-access-token', new AbortController().signal, receive,
      (_url, options) => new WebSocket(`ws://127.0.0.1:${port}/v1/session`, options))).rejects.toThrow(/^Account relay unavailable\.$/);
    expect(audio).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
  } finally { await relay.stop(); }
}, 5000);
