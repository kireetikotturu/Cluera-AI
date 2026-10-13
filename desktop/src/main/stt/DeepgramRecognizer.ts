import WebSocket from 'ws';
import type { AudioSourceDescriptor, TranscriptEvent, TurnEvent } from '../../shared/types';
import type { AppConfig } from '../config/appConfig';
import type { SpeechRecognizer } from './SpeechRecognizer';

interface FluxWord { confidence?: number }
interface FluxMessage { type?: string; event?: string; transcript?: string; words?: FluxWord[] }

export interface ParsedFluxMessage {
  eventName: string;
  transcript: string;
  confidence: number;
  transcriptEvent?: TranscriptEvent;
  turnEvent?: TurnEvent;
}

export function createTranscriptEvent(source: AudioSourceDescriptor, text: string, isFinal: boolean, confidence: number, timestamp = Date.now()): TranscriptEvent {
  return { text, isFinal, sourceId: source.id, sourceKind: source.kind, sourceRole: source.role, canTriggerAnswers: source.canTriggerAnswers, confidence, timestamp };
}

export function parseFluxMessage(raw: string, source: AudioSourceDescriptor, timestamp = Date.now()): ParsedFluxMessage {
  const data = JSON.parse(raw) as FluxMessage;
  const transcript = data.transcript?.trim() ?? '';
  const eventName = data.event ?? data.type ?? '';
  const reportedConfidences = data.words
    ?.map((word) => word.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  // Flux sometimes includes word timing objects without confidence. Treat that
  // as unreported confidence instead of zero, otherwise valid candidate speech
  // is persisted but incorrectly rejected by the shared-transcript arbiter.
  const confidence = reportedConfidences?.length
    ? reportedConfidences.reduce((sum, value) => sum + value, 0) / reportedConfidences.length
    : 0.9;
  const metadata = { sourceId: source.id, sourceKind: source.kind, sourceRole: source.role, canTriggerAnswers: source.canTriggerAnswers };
  const type = eventName === 'StartOfTurn' ? 'start' : eventName === 'EagerEndOfTurn' ? 'eager-end' : eventName === 'TurnResumed' ? 'resume' : eventName === 'EndOfTurn' ? 'end' : undefined;
  return {
    eventName, transcript, confidence,
    transcriptEvent: transcript ? createTranscriptEvent(source, transcript, eventName === 'EndOfTurn', confidence, timestamp) : undefined,
    turnEvent: type ? { type, transcript, ...metadata, timestamp } : undefined,
  };
}

export class DeepgramRecognizer implements SpeechRecognizer {
  private socket: WebSocket | null = null;
  private retries = 0;
  private manuallyStopped = false;
  private queued: Buffer[] = [];
  private partialCallback: (data: TranscriptEvent) => void = () => undefined;
  private finalCallback: (data: TranscriptEvent) => void = () => undefined;
  private turnCallback: (event: TurnEvent) => void = () => undefined;
  private errorCallback: (error: Error) => void = () => undefined;
  private forceEndTimer: ReturnType<typeof setTimeout> | null = null;
  private latestTranscript = '';

  constructor(private readonly config: AppConfig['deepgram'], private readonly source: AudioSourceDescriptor) {}

  start(): Promise<void> {
    if (!this.config.apiKey && !this.config.managed) return Promise.reject(new Error('Deepgram API key is not configured.'));
    this.manuallyStopped = false;
    return this.connect();
  }

  sendAudio(chunk: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
    else if (this.queued.length < 30) this.queued.push(chunk);
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true;
    this.clearForceEndTimer();
    this.queued = [];
    if (!this.socket) return;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    this.socket.close();
    this.socket = null;
  }

  onPartialTranscript(callback: (data: TranscriptEvent) => void): void { this.partialCallback = callback; }
  onFinalTranscript(callback: (data: TranscriptEvent) => void): void { this.finalCallback = callback; }
  onTurnEvent(callback: (event: TurnEvent) => void): void { this.turnCallback = callback; }
  onError(callback: (error: Error) => void): void { this.errorCallback = callback; }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({ model: this.config.model, encoding: 'linear16', sample_rate: '16000', eot_threshold: String(this.config.eotThreshold), eot_timeout_ms: '4500' });
      if (this.config.model.includes('multi') && this.config.language) query.append('language_hint', this.config.language);
      const managed = this.config.managed?.(this.source.role === 'local_candidate' ? 'candidate' : 'system');
      const socket = new WebSocket(managed?.url ?? `wss://api.deepgram.com/v2/listen?${query}`, {
        headers: managed?.headers ?? { Authorization: `Token ${this.config.apiKey}` },
        handshakeTimeout: 10_000, followRedirects: false, maxPayload: 256_000,
      });
      this.socket = socket;
      let settled = false;
      socket.on('open', () => {
        settled = true;
        // A proxy handshake alone is not proof the provider is connected.
        // Otherwise upstream failures reset backoff forever in Managed mode.
        if (!managed) this.retries = 0;
        for (const chunk of this.queued.splice(0)) socket.send(chunk);
        resolve();
      });
      socket.on('message', (raw) => this.handleMessage(raw.toString(), Boolean(managed)));
      socket.on('error', (error) => { const safe = managed ? new Error('Cluera Managed transcription could not connect. Check account access, network and service availability.') : error; if (!settled) reject(safe); else this.errorCallback(safe); });
      socket.on('close', () => { this.clearForceEndTimer(); if (!this.manuallyStopped) void this.reconnect(); });
    });
  }

  private handleMessage(raw: string, managed = false): void {
    try {
      const parsed = parseFluxMessage(raw, this.source);
      if (managed && parsed.eventName === 'Connected') this.retries = 0;
      if (parsed.transcriptEvent) {
        if (parsed.eventName === 'EndOfTurn') this.finalCallback(parsed.transcriptEvent);
        else this.partialCallback(parsed.transcriptEvent);
      }
      if (parsed.turnEvent) this.turnCallback(parsed.turnEvent);
      if (parsed.eventName === 'EndOfTurn') { this.clearForceEndTimer(); this.latestTranscript = ''; }
      else if (parsed.transcript && parsed.transcript !== this.latestTranscript) { this.latestTranscript = parsed.transcript; this.armForceEndTimer(); }
    } catch (error) { this.errorCallback(error instanceof Error ? error : new Error('Invalid Deepgram response')); }
  }

  private armForceEndTimer(): void {
    this.clearForceEndTimer();
    this.forceEndTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN && this.latestTranscript) this.socket.send(JSON.stringify({ type: 'ForceEndTurn' }));
      this.forceEndTimer = null;
    }, 3_200);
  }

  private clearForceEndTimer(): void { if (this.forceEndTimer) clearTimeout(this.forceEndTimer); this.forceEndTimer = null; }

  private async reconnect(): Promise<void> {
    if (this.retries >= this.config.maxReconnects) { this.errorCallback(new Error('Deepgram connection could not be restored.')); return; }
    const delay = Math.min(8_000, 750 * 2 ** this.retries++);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!this.manuallyStopped) try { await this.connect(); } catch (error) { this.errorCallback(error instanceof Error ? error : new Error('Deepgram reconnect failed')); }
  }
}
