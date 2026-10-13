import type { AnswerContext } from '../../shared/types';
import type { AppConfig } from '../config/appConfig';
import type { AnswerModel } from './AnswerModel';
import { PromptBuilder } from './PromptBuilder';
import { fastThinkingConfig } from './geminiThinking';
import { redactSecrets } from '../security/redaction';
import { MANAGED_GEMINI_MODEL } from '../../shared/managedProviders';

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

interface ParsedGeminiSseEvent {
  text: string;
  finishReason?: string;
}

export function parseGeminiSseChunk(event: string): ParsedGeminiSseEvent {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return { text: '' };
  const parsed = JSON.parse(data) as GeminiChunk;
  const candidate = parsed.candidates?.[0];
  return {
    text: candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
    finishReason: candidate?.finishReason,
  };
}

export function parseGeminiSseEvent(event: string): string {
  return parseGeminiSseChunk(event).text;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Gemini request was canceled.', 'AbortError');
}

function waitForActivity<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal,
  abortRequest: () => void, phase: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const complete = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => { if (complete()) reject(cancellationError(signal)); };
    const timer = setTimeout(() => {
      if (complete()) {
        reject(new Error(`Gemini ${phase} timed out after ${timeoutMs} ms without data. Please retry the question.`));
        abortRequest();
      }
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    work.then((value) => { if (complete()) resolve(value); },
      (error: unknown) => { if (complete()) reject(error instanceof Error ? error : new Error(String(error))); });
  });
}

export class GeminiAnswerModel implements AnswerModel {
  get name(): string { return this.config.managed ? MANAGED_GEMINI_MODEL : this.config.model; }
  constructor(private readonly config: AppConfig['gemini'], private readonly prompts: PromptBuilder,
    private readonly modelAllowed: (modelId: string) => boolean | Promise<boolean> = () => true) {}

  async *streamAnswer(context: AnswerContext, signal: AbortSignal): AsyncIterable<string> {
    if (!this.config.apiKey && !this.config.managed) throw new Error('Gemini API key is not configured. Add your Gemini API key in Settings.');
    const selectedModel = this.config.managed && !this.config.managedModelSelection ? MANAGED_GEMINI_MODEL : context.session.selectedModel || this.config.model;
    if (!await this.modelAllowed(selectedModel)) throw new Error(`Gemini model ${selectedModel} is unavailable in Cluera's model catalog. Choose an enabled model in Settings; no other model was selected automatically.`);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent?alt=sse`;
    const maxOutputTokens = context.session.answerLength === 'detailed' ? 3_000 : context.session.answerLength === 'medium' ? 1_500 : 800;
    const thinkingConfig = fastThinkingConfig(selectedModel);
    const timeoutMs = Number.isFinite(this.config.timeoutMs) && this.config.timeoutMs > 0
      ? Math.min(this.config.timeoutMs, 120_000) : 30_000;
    const requestAbort = new AbortController();
    const abortRequest = (): void => requestAbort.abort();
    signal.addEventListener('abort', abortRequest, { once: true });
    if (signal.aborted) abortRequest();
    try {
      const send = this.config.managed;
      const providerFetch = (_endpoint: string, init: RequestInit): Promise<Response> => send
        ? send(String(init.body), requestAbort.signal) : fetch(_endpoint, init);
      const response = await waitForActivity(providerFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey }, signal: requestAbort.signal,
        body: JSON.stringify({
          ...(this.config.managedModelSelection ? { modelId: selectedModel } : {}),
          contents: [{ role: 'user', parts: [{ text: this.prompts.build(context) }] }],
          generationConfig: {
            temperature: 0.35,
            topP: 0.9,
            maxOutputTokens,
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
      }), timeoutMs, signal, abortRequest, 'response headers');
      if (!response.ok || !response.body) {
        const detail = await waitForActivity(response.text(), timeoutMs, signal, abortRequest, 'error response');
        throw new Error(`Gemini request failed (${response.status}): ${redactSecrets(detail.slice(0, 300), [this.config.apiKey])}`);
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason: string | undefined;
      const reader = response.body.getReader();
      let streamFinished = false;
      try {
        while (true) {
          const { done, value } = await waitForActivity(reader.read(), timeoutMs, signal, abortRequest, 'response stream');
          if (done) { streamFinished = true; break; }
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? '';
          for (const event of events) {
            const chunk = parseGeminiSseChunk(event);
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.text) yield chunk.text;
          }
        }
      } finally {
        if (!streamFinished) {
          abortRequest();
          void reader.cancel().catch(() => undefined);
        }
        try { reader.releaseLock(); } catch { /* Abort may still be settling a pending read. */ }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const chunk = parseGeminiSseChunk(buffer);
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.text) yield chunk.text;
      }
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(`Gemini stopped before completing the answer (${finishReason}). Please retry the question.`);
      }
    } finally {
      signal.removeEventListener('abort', abortRequest);
    }
  }
}
