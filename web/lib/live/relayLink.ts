import type { RelayChannel, RelayCommand, RelayIncoming, SocketLike } from './types';

const OPEN = 1;
const CHANNELS = ['interviewer', 'candidate'];
const FLUX_EVENTS = ['StartOfTurn', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn', 'Update'];
/** While more than this is waiting to be sent (a photo still uploading, a slow network) audio pieces are skipped, not queued. */
export const AUDIO_BACKLOG_BYTES = 256_000;
/** The relay accepts the first message for this long; a link that does not become ready is treated as failed. */
export const CONNECT_TIMEOUT_MS = 20_000;

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
/** The relay accepts only a proper UUID as the app session of a connection. */
const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reads one message from the relay. Anything that is not exactly a known message is rejected. */
export function parseIncoming(raw: unknown): RelayIncoming | null {
  if (typeof raw !== 'string' || raw.length > 256_000) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  switch (value.type) {
    case 'ready': return { type: 'ready' };
    case 'sessionEnded': return { type: 'sessionEnded' };
    case 'answerDone': return id(value.id) ? { type: 'answerDone', id: value.id } : null;
    case 'answerFailed': return id(value.id) ? { type: 'answerFailed', id: value.id } : null;
    case 'answer': return id(value.id) && typeof value.text === 'string' ? { type: 'answer', id: value.id, text: value.text } : null;
    case 'audioReady': return CHANNELS.includes(value.channel as string) ? { type: 'audioReady', channel: value.channel as RelayChannel } : null;
    case 'transcript':
      return CHANNELS.includes(value.channel as string) && FLUX_EVENTS.includes(value.event as string) && typeof value.transcript === 'string'
        ? { type: 'transcript', channel: value.channel as RelayChannel, event: value.event as never, transcript: value.transcript } : null;
    default: return null;
  }
}

export interface LinkHandlers {
  onEvent(event: Exclude<RelayIncoming, { type: 'ready' | 'sessionEnded' }>): void;
  /** The link ended for any reason (the relay finished the session, the network dropped, or this side closed it). */
  onClose(): void;
}

/** One authorized connection to the live relay. Nothing is sent before the relay says it is ready. */
export class RelayLink {
  private closed = false;
  /** The owner only hears about a link it was given. */
  private announced = false;
  private readonly ready = new Set<RelayChannel>();
  private constructor(private readonly socket: SocketLike, private readonly handlers: LinkHandlers) {}

  static connect(open: () => SocketLike, accessToken: string, handlers: LinkHandlers, timeoutMs = CONNECT_TIMEOUT_MS, sessionRef?: string): Promise<RelayLink> {
    return new Promise<RelayLink>((resolve, reject) => {
      let settled = false;
      let credential = accessToken;
      let socket: SocketLike;
      try { socket = open(); } catch { reject(new Error('The live connection could not be opened.')); return; }
      socket.binaryType = 'arraybuffer';
      const link = new RelayLink(socket, handlers);
      const fail = (): void => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('The live connection could not be opened.')); }
        link.finish();
      };
      const timer = setTimeout(fail, timeoutMs);
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: 'authenticate', accessToken: credential, ...(sessionRef && SESSION_REF.test(sessionRef) ? { sessionRef } : {}) }));
        } catch { fail(); }
        credential = '';
      };
      socket.onmessage = event => {
        if (link.closed) return;
        const message = parseIncoming(event.data);
        if (!message) { link.finish(); return; }
        if (!settled) {
          if (message.type !== 'ready') { fail(); return; }
          settled = true; clearTimeout(timer); link.announced = true; resolve(link); return;
        }
        if (message.type === 'ready') { link.finish(); return; }
        if (message.type === 'sessionEnded') { link.finish(); return; }
        if (message.type === 'audioReady') link.ready.add(message.channel);
        handlers.onEvent(message);
      };
      socket.onerror = () => { if (!settled) fail(); };
      socket.onclose = () => { if (!settled) fail(); else link.finish(); };
    });
  }

  get open(): boolean { return !this.closed && this.socket.readyState === OPEN; }
  isReady(channel: RelayChannel): boolean { return this.ready.has(channel); }

  send(command: RelayCommand): void {
    if (!this.open) throw new Error('The live connection is not open.');
    if (command.type === 'openAudio') this.ready.delete(command.channel);
    if (command.type === 'closeAudio') this.ready.delete(command.channel);
    this.socket.send(JSON.stringify(command));
  }

  /** Sends one piece of 16 kHz sound. Skipped while the link is busy or the channel is not ready; never queued. */
  writeAudio(channel: RelayChannel, samples: Int16Array): boolean {
    if (!this.open || !this.ready.has(channel) || !samples.length) return false;
    if (this.socket.bufferedAmount > AUDIO_BACKLOG_BYTES) return false;
    const frame = new Uint8Array(1 + samples.byteLength);
    frame[0] = channel === 'interviewer' ? 0 : 1;
    frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 1);
    this.socket.send(frame);
    return true;
  }

  /** Ends the session politely: the relay stops the clock at once. */
  stop(): void {
    if (this.closed) return;
    try { if (this.socket.readyState === OPEN) this.socket.send(JSON.stringify({ type: 'stop' } satisfies RelayCommand)); } catch { /* closing anyway */ }
    this.finish(1000);
  }

  /** Cuts the link without a goodbye (used to start again on a fresh connection). */
  drop(): void { this.finish(); }

  private finish(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.ready.clear();
    try { this.socket.onmessage = null; this.socket.onerror = null; this.socket.onclose = null; this.socket.close(code); } catch { /* already closed */ }
    if (this.announced) this.handlers.onClose();
  }
}
