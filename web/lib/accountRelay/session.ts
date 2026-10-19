import WebSocket from 'ws';
import type { createUsageCoordinator } from '../usage/coordinator';
import type { RelayAuthorization } from './authorization';
import { authFrame, commandFrame, type Channel } from './protocol';
import type { Providers, AudioConnection } from './providers';

export type RelayEvent = 'authenticated' | 'authorization_failed' | 'provider_failed' | 'usage_stopped' | 'protocol_rejected'
  | 'close_requested' | 'close_failed' | 'close_deadline_reached' | 'socket_closed'
  | 'terminal_write_complete' | 'terminal_write_failed';

/** One socket = one actual AI session; interviewer + candidate + Gemini share
 * one server-owned ledger run. No charge for the connected/pre-start dashboard. */
export function attachRelaySession(peer: WebSocket, dependencies: {
  authorize(token: string): Promise<RelayAuthorization>;
  providers: Providers;
  observe?: (event: RelayEvent) => void;
}) {
  let ended = false, authenticating = false, authorization: RelayAuthorization | undefined;
  let run: ReturnType<typeof createUsageCoordinator> | undefined;
  let starting: Promise<void> | undefined;
  let generation: AbortController | undefined, generating = false;
  let controls = 0, controlTime = performance.now(), lastGeneration = -Infinity;
  const authenticationDeadline = performance.now() + 10000;
  let tokenDeadline = 0;
  const channels = new Map<Channel, AudioConnection>();
  const opening = new Set<Channel>();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let pongDeadline: ReturnType<typeof setTimeout> | undefined;
  let awaitingPong = false;
  let idle = setTimeout(() => end('authorization_failed'), 10000);
  let closedTimer: ReturnType<typeof setTimeout> | undefined;
  // Diagnostics must never prevent credential denial, cancellation or closure.
  function observe(event: RelayEvent) { try { dependencies.observe?.(event); } catch { /* fixed event only */ } }
  function end(event: RelayEvent = 'usage_stopped') {
    if (ended) return; ended = true;
    clearTimeout(idle); clearTimeout(expiry); clearTimeout(heartbeat); clearTimeout(pongDeadline);
    generation?.abort(); for (const audio of channels.values()) audio.close(); channels.clear(); opening.clear();
    run?.stop(); observe(event);
    if (peer.readyState !== WebSocket.CLOSED) {
      // Keep the existing code/reason/deadline. Separate lifecycle events let
      // operators distinguish a local close attempt from an ingress/client issue.
      closedTimer = setTimeout(() => { observe('close_deadline_reached'); peer.terminate(); }, 1000);
      closedTimer.unref();
      // A close frame alone may not propagate through every intermediary. This
      // fixed terminal frame grants no access and contains no account/error data.
      // Never wait for its callback before closing or extend the force deadline.
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount <= 256000) {
        try {
          peer.send('{"type":"sessionEnded"}', error => observe(error ? 'terminal_write_failed' : 'terminal_write_complete'));
        } catch { observe('terminal_write_failed'); }
      }
      try {
        peer.close(event === 'usage_stopped' ? 1000 : 1008, 'Account session ended.');
        observe('close_requested');
      } catch { observe('close_failed'); peer.terminate(); }
    }
  }
  function active() {
    if (ended || performance.now() >= tokenDeadline) { end('authorization_failed'); throw Error('Session closed.'); }
    run!.assertActive();
  }
  function send(value: object, requireUsage = true) {
    if (requireUsage) active();
    if (ended || peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > 256000) throw Error('Session unavailable.');
    peer.send(JSON.stringify(value));
  }
  function touch() {
    clearTimeout(idle);
    // Only real audio/commands/output, not client keepalive, refresh the idle limit.
    idle = setTimeout(() => end(), 45000);
  }
  function schedulePing() {
    if (ended) return;
    heartbeat = setTimeout(() => {
      try {
        active(); awaitingPong = true;
        pongDeadline = setTimeout(() => end(), 10000);
        peer.ping();
      } catch { end(); }
    }, 20000);
  }
  peer.on('pong', () => {
    if (ended || !awaitingPong) return;
    awaitingPong = false; clearTimeout(pongDeadline); schedulePing();
  });
  async function ensureStarted() {
    if (!authorization || ended || performance.now() >= tokenDeadline) throw Error('Session unavailable.');
    if (!run) {
      run = authorization.createRun();
      run.signal.addEventListener('abort', () => end(), { once: true });
      starting = run.start();
      void starting.then(schedulePing, () => undefined);
    }
    await starting; active();
  }
  peer.on('error', () => end());
  peer.on('close', () => { end(); clearTimeout(closedTimer); observe('socket_closed'); });
  peer.on('message', (raw, binary) => {
    if (ended) return;
    const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
    if (!authorization) {
      if (authenticating || binary || bytes.length > 16000) { end('protocol_rejected'); return; }
      authenticating = true;
      void (async () => {
        try {
          const parsed = authFrame.parse(JSON.parse(bytes.toString()));
          const result = await dependencies.authorize(parsed.accessToken);
          if (ended) return;
          if (performance.now() >= authenticationDeadline) throw Error();
          if (!Number.isFinite(result.remainingTokenMs) || result.remainingTokenMs < 1 || result.remainingTokenMs > 3600000) throw Error();
          authorization = result;
          tokenDeadline = performance.now() + result.remainingTokenMs;
          expiry = setTimeout(() => end('authorization_failed'), result.remainingTokenMs);
          touch(); observe('authenticated'); send({ type: 'ready', protocol: 1 }, false);
        } catch { end('authorization_failed'); }
      })();
      return;
    }
    if (binary) {
      try {
        active();
        if (bytes.length < 3 || bytes.length > 8193 || ![0, 1].includes(bytes[0])) throw Error();
        const audio = channels.get(bytes[0] === 0 ? 'interviewer' : 'candidate');
        if (!audio) throw Error();
        audio.write(bytes.subarray(1)); touch();
      } catch { end('protocol_rejected'); }
      return;
    }
    try {
      const now = performance.now();
      if (now - controlTime >= 1000) { controls = 0; controlTime = now; }
      if (++controls > 8) throw Error();
      const command = commandFrame.parse(JSON.parse(bytes.toString()));
      if (command.type === 'stop') { end(); return; }
      if (command.type === 'cancelGeneration') { generation?.abort(); return; }
      if (command.type === 'closeAudio') {
        if (opening.has(command.channel)) { end(); return; }
        channels.get(command.channel)?.close(); channels.delete(command.channel); return;
      }
      if (command.type === 'forceEndTurn') { active(); channels.get(command.channel)?.forceEndTurn(); return; }
      if (command.type === 'openAudio') {
        if (channels.has(command.channel) || opening.has(command.channel)) throw Error();
        opening.add(command.channel);
        void (async () => {
          try {
            await dependencies.providers.prepare?.('deepgram');
            await ensureStarted();
            const audio = dependencies.providers.audio(run!, value => send({ type: 'transcript', channel: command.channel, ...value }),
              () => end('provider_failed'), () => {
                if (ended) return;
                try {
                  active(); opening.delete(command.channel); touch();
                  send({ type: 'audioReady', channel: command.channel });
                } catch { end('provider_failed'); }
              });
            if (ended) { audio.close(); return; }
            channels.set(command.channel, audio); touch();
          } catch { end('provider_failed'); }
        })();
        return;
      }
      if (generating || now - lastGeneration < 1000) throw Error();
      generating = true; lastGeneration = now;
      const abort = new AbortController(); generation = abort;
      void (async () => {
        try {
          await dependencies.providers.prepare?.('gemini',command);
          // Cancellation during a vault/model lookup must not start a paid run.
          // Existing audio keeps its own shared run; this question emits no work.
          if (abort.signal.aborted || ended) return;
          await ensureStarted(); touch();
          if (abort.signal.aborted) return;
          const signal = AbortSignal.any([run!.signal, abort.signal]);
          await dependencies.providers.generate(command, { signal, assertActive() { active(); if (signal.aborted) throw Error(); } }, text => {
            active(); if (signal.aborted) throw Error(); touch(); send({ type: 'answer', id: command.id, text });
          });
          if (!signal.aborted) send({ type: 'answerDone', id: command.id });
        } catch { if (!abort.signal.aborted) end('provider_failed'); }
        finally {
          generating = false;
          if (generation === abort) generation = undefined;
          // A cancelled generation is settled before a client may submit a new
          // one on this audio session. No cancelled answer content is emitted.
          if (abort.signal.aborted && !ended) {
            // A pre-start cancellation has no usage grant. Its fixed, content-free
            // acknowledgement is safe without one and must never reject this task.
            try { send({ type:'answerDone', id:command.id }, false); }
            catch { end(); }
          }
        }
      })();
    } catch { end('protocol_rejected'); }
  });
  return { stop: () => end() };
}
