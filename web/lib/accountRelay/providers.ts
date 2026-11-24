import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { DEEPGRAM_MODEL, GEMINI_MODEL, secretFilter, type Generate } from './protocol';
import {providerReceiptMetadata} from '../aiProviders/telemetry';
import {receiptMetadataSchema,type ReceiptMetadata} from '../aiProviders/usageMetadata';

export type Guard = { signal: AbortSignal; assertActive(): void; runId?:string };
export type ProviderSecrets = { geminiKey?: string; deepgramKey?: string; openaiKey?: string; anthropicKey?: string; serviceKey: string; rateKey: string };
export type AudioConnection = { write(bytes: Buffer): void; forceEndTurn(): void; close(): void };
export type Providers = {
  prepare?(kind:'gemini'|'deepgram',input?:Generate):Promise<void>;
  generate(input: Generate, guard: Guard, emit: (text: string) => void): Promise<void>;
  audio(guard: Guard, emit: (value: { event: string; transcript: string }) => void, failed: () => void,
    ready?: () => void): AudioConnection;
};
const fluxEvents = new Set(['StartOfTurn', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn', 'Update']);
const unavailable = () => new Error('Provider unavailable.');

/** No arbitrary upstream URL/model, no cookies, no forwarded client headers,
 * metadata or raw upstream errors. Both adapters terminate on grant cancellation. */
export function providerAdapters(secrets: ProviderSecrets, dependencies: {
  fetch?: typeof fetch; connect?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  resolveModel?: (input: Generate) => Promise<string>;
  receipt?: (metadata:ReceiptMetadata)=>void;
  /** Which answer provider serves this request (default Gemini). */
  textProvider?: 'gemini' | 'openai' | 'anthropic';
  /** Deepgram Flux model for live transcription (default flux-general-en). */
  audioModel?: string;
} = {}): Providers {
  const request = dependencies.fetch ?? fetch;
  const connect = dependencies.connect ?? ((url, options) => new WebSocket(url, options));
  const privateValues = [secrets.geminiKey, secrets.deepgramKey, secrets.openaiKey, secrets.anthropicKey, secrets.serviceKey, secrets.rateKey].filter((v):v is string=>Boolean(v));
  return {
    async generate(input, guard, emit) {
      guard.assertActive();
      if (dependencies.textProvider === 'openai' || dependencies.textProvider === 'anthropic') {
        const key = dependencies.textProvider === 'openai' ? secrets.openaiKey : secrets.anthropicKey;
        if (!key || !dependencies.resolveModel) throw unavailable();
        const selected = await dependencies.resolveModel(input);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(selected)) throw unavailable();
        return chatGenerate(dependencies.textProvider, key, selected, input, guard, emit, request, privateValues, dependencies.receipt);
      }
      if(!secrets.geminiKey)throw unavailable();
      const selectedModel = dependencies.resolveModel ? await dependencies.resolveModel(input) : GEMINI_MODEL;
      if (!dependencies.resolveModel && input.modelId && input.modelId !== GEMINI_MODEL) throw unavailable();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(selectedModel)) throw unavailable();
      guard.assertActive();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, guard.signal]);
      const cancel = () => controller.abort();
      const total = setTimeout(cancel, 90000);
      let idle = setTimeout(cancel, 45000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const filter = secretFilter(privateValues);
      const timing: { headersMs?: number; firstTokenMs?: number; thinking?: string } = {}, begun = performance.now();
      try {
        const started = performance.now();
        const post = (thinkingConfig: Record<string, unknown> | undefined) => request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent?alt=sse`, {
          method: 'POST', redirect: 'error', signal, cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': secrets.geminiKey! },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input.prompt },
            ...(input.image ? [{ inlineData: input.image }] : [])] }],
          generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: input.maxTokens ?? 3000, ...(thinkingConfig ? { thinkingConfig } : {}) } }),
        });
        // Fastest answers: keep "thinking" minimal. A brand-new model that rejects that setting
        // is retried once without it, so adding any new Gemini model just works.
        // Try the quickest "thinking" setting this model accepts; the first one it accepts is remembered
        // per model, so new Gemini models are tuned automatically after their first question.
        const ladder = geminiThinkingLadder(selectedModel);
        const known = geminiThinkingChoice.get(selectedModel);
        let response!: Response, used = 'default';
        for (const step of known === undefined ? ladder.map((_, index) => index) : [known]) {
          const config = ladder[step];
          response = await post(config);
          used = config ? JSON.stringify(config) : 'default';
          if (response.status !== 400) { geminiThinkingChoice.set(selectedModel, step); break; }
          await response.body?.cancel().catch(() => undefined);
        }
        timing.thinking = used;
        guard.assertActive();
        timing.headersMs = Math.round(performance.now() - started);
        if (!response.ok || !response.body) { logAnswerFailure('gemini', selectedModel, `http-${response.status}`, begun); await response.body?.cancel(); throw unavailable(); }
        reader = response.body.getReader();
        let buffer = '', totalBytes = 0, hasAnswer = false;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const event = (raw: string) => {
          guard.assertActive();
          if (signal.aborted) throw unavailable();
          const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim();
          if (!data || data === '[DONE]') return;
          const value = JSON.parse(data);
          const receipt=providerReceiptMetadata('gemini',value);if(receipt)dependencies.receipt?.(receipt);
          if (value.error) throw unavailable();
          // Gemini can return HTTP 200 for blocked prompts/candidates. These are
          // bounded failures, never a successful empty or policy-blocked answer.
          if (value.promptFeedback?.blockReason) throw unavailable();
          const candidate = value.candidates?.[0];
          if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw unavailable();
          const parts = candidate?.content?.parts;
          if (!Array.isArray(parts)) return;
          for (const part of parts) {
            if (typeof part.text !== 'string' || part.thought) continue;
            if (part.text.trim()) hasAnswer = true;
            const text = filter.push(part.text);
            if (text) { if (timing.firstTokenMs === undefined) timing.firstTokenMs = Math.round(performance.now() - begun); emit(text); }
          }
        };
        while (true) {
          guard.assertActive();
          const { done, value } = await reader.read();
          guard.assertActive();
          if (signal.aborted) throw unavailable();
          if (done) break;
          clearTimeout(idle); idle = setTimeout(cancel, 45000);
          totalBytes += value.byteLength;
          if (totalBytes > 1_000_000) throw unavailable();
          buffer += decoder.decode(value, { stream: true });
          // Parse events before testing the remaining partial-event buffer bound.
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            if (boundary.index > 128000) throw unavailable();
            event(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
          }
          if (buffer.length > 128000) throw unavailable();
        }
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer);
        guard.assertActive();
        if (!hasAnswer) throw unavailable();
        const final = filter.push('', true); if (final) emit(final);
        logAnswerTiming('gemini', selectedModel, timing, begun);
      } catch {
        if (!guard.signal.aborted) logAnswerFailure('gemini', selectedModel, timing.firstTokenMs === undefined ? (timing.headersMs === undefined ? 'no-reply-from-google' : 'no-words-after-reply') : 'stream-stopped', begun);
        throw unavailable();
      }
      finally { clearTimeout(total); clearTimeout(idle); cancel(); await reader?.cancel().catch(() => undefined); }
    },
    audio(guard, emit, failed, ready = () => {}) {
      guard.assertActive();
      if(!secrets.deepgramKey)throw unavailable();
      let ended = false, upstream: WebSocket | undefined;
      let queue: Buffer[] = [], queued = 0, allowance = 96000, previous = performance.now();
      let idle: ReturnType<typeof setTimeout>;
      function close() {
        if (ended) return; ended = true; clearTimeout(idle);
        guard.signal.removeEventListener('abort', close);
        queue = []; queued = 0; upstream?.terminate();
      }
      function fail() { if (ended) return; close(); failed(); }
      function active() { if (ended || guard.signal.aborted) throw unavailable(); guard.assertActive(); }
      function touch() { clearTimeout(idle); idle = setTimeout(fail, 15000); }
      guard.signal.addEventListener('abort', close, { once: true });
      try {
        active();
        const audioModel = dependencies.audioModel ?? DEEPGRAM_MODEL;
        if (!/^flux-[a-z0-9-]{1,60}$/.test(audioModel)) throw unavailable();
        upstream = connect(`wss://api.deepgram.com/v2/listen?model=${encodeURIComponent(audioModel)}&encoding=linear16&sample_rate=16000&eot_threshold=0.75&eot_timeout_ms=4500`, {
          headers: { Authorization: `Token ${secrets.deepgramKey}` }, handshakeTimeout: 8000,
          followRedirects: false, maxPayload: 128000, perMessageDeflate: false,
        });
        touch();
        upstream.once('open', () => {
          try {
            active(); for (const bytes of queue) { active(); upstream!.send(bytes); } queue = []; queued = 0;
            // Upstream has completed its authenticated handshake. A constructed
            // local socket is not readiness, and late opens after stop cannot emit.
            active(); ready();
          }
          catch { fail(); }
        });
        upstream.on('message', raw => {
          try {
            active();
            const value = JSON.parse(raw.toString());
            const receipt=providerReceiptMetadata('deepgram',value);if(receipt)dependencies.receipt?.(receipt);
            if (value.type === 'Error') throw unavailable();
            if (!fluxEvents.has(value.event) || typeof value.transcript !== 'string' || value.transcript.length > 16000) return;
            const transcript = secretFilter(privateValues).push(value.transcript, true);
            emit({ event: value.event, transcript });
          } catch { fail(); }
        });
        upstream.on('unexpected-response', (_request, response) => { response.destroy(); fail(); });
        upstream.on('error', fail); upstream.on('close', fail);
      } catch { close(); throw unavailable(); }
      return {
        write(bytes) {
          try {
            active();
            const now = performance.now(); allowance = Math.min(96000, allowance + Math.max(0, now - previous) * 32); previous = now;
            if (!bytes.length || bytes.length > 8192 || bytes.length % 2 || bytes.length > allowance) throw unavailable();
            allowance -= bytes.length; touch();
            if (upstream?.readyState === WebSocket.OPEN) {
              if (upstream.bufferedAmount > 128000) throw unavailable();
              upstream.send(bytes);
            } else if (queued + bytes.length <= 96000) { queue.push(bytes); queued += bytes.length; }
            else throw unavailable();
          } catch { fail(); throw unavailable(); }
        },
        forceEndTurn() { active(); if (upstream?.readyState === WebSocket.OPEN) upstream.send('{"type":"ForceEndTurn"}'); },
        close,
      };
    },
  };
}

/** Gemini thinking settings per model family (mirrors the desktop app); unknown families send none. */
const geminiThinkingChoice = new Map<string, number>();
/** Fastest-first thinking settings to try for any Gemini model; the last entry (undefined) is "no setting". */
export function geminiThinkingLadder(model: string): Array<Record<string, unknown> | undefined> {
  const id = model.toLowerCase();
  if (/^gemini-(?:1\.|2\.0)/.test(id)) return [undefined];                       // no thinking controls
  if (/^gemini-2\.5-pro/.test(id)) return [{ thinkingBudget: 128 }, undefined];     // cannot be switched off
  if (/^gemini-2\.5-/.test(id)) return [{ thinkingBudget: 0 }, undefined];
  if (/pro/.test(id)) return [{ thinkingLevel: 'low' }, { thinkingBudget: 128 }, undefined];
  // Flash / Lite / newer families (3.x, 4.x, aliases such as gemini-flash-latest).
  return [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, undefined];
}
/** Secret-free speed log: how long the provider took to answer and to send the first words. */
function logAnswerFailure(provider: string, model: string, stage: string, begun: number) {
  try { console.warn(JSON.stringify({ component: 'cluera-answer-failure', provider, model, stage, afterMs: Math.round(performance.now() - begun) })); }
  catch { /* Logging never affects an answer. */ }
}
function logAnswerTiming(provider: string, model: string, timing: { headersMs?: number; firstTokenMs?: number; thinking?: string }, begun: number) {
  try { console.info(JSON.stringify({ component: 'cluera-answer-timing', provider, model, providerReplyMs: timing.headersMs ?? null,
    thinking: timing.thinking ?? null, firstWordsMs: timing.firstTokenMs ?? null, totalMs: Math.round(performance.now() - begun) })); } catch { /* Logging never affects an answer. */ }
}
const ANSWER_SYSTEM = 'You are Cluera, a concise interview copilot. Answer clearly and directly.';

/** Fastest-first "reasoning effort" values to try for an OpenAI model; the last entry is "no setting".
 * GPT-5 family models think by default, which delays the first word; "minimal" (GPT-5) or "none"
 * (GPT-5.1 and later) switches that off. A model that rejects a value is retried with the next one and the
 * accepted value is remembered, so new OpenAI models are tuned by their first question. Chat-style
 * models (GPT-4o, GPT-4.1, *-chat-latest) have no such setting. */
export function openaiReasoningLadder(model: string): Array<string | undefined> {
  const id = model.toLowerCase();
  if (/^gpt-(?:[5-9]|\d{2,})/.test(id) && !id.includes('chat')) return ['minimal', 'none', 'low', undefined];
  if (/^o\d/.test(id)) return ['low', undefined];
  return [undefined];
}
const openaiReasoningChoice = new Map<string, number>();
/** Claude models that rejected a custom temperature (remembered). */
const anthropicNoTemperature = new Set<string>();

const countOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
const requestId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
  ? createHash('sha256').update(value).digest('hex') : undefined;
/** Only documented numeric usage fields; never prompt, answer, headers or raw provider bodies. */
function chatReceipt(parts: { id?: string; input?: number; output?: number; thinking?: number; cached?: number; total?: number }): ReceiptMetadata | undefined {
  const result: Record<string, unknown> = {};
  const hash = requestId(parts.id); if (hash) result.requestHash = hash;
  if (parts.input !== undefined) result.inputTokens = parts.input;
  if (parts.output !== undefined) result.outputTokens = parts.output;
  if (parts.thinking !== undefined) result.thinkingTokens = parts.thinking;
  if (parts.cached !== undefined) result.cachedTokens = parts.cached;
  if (parts.total !== undefined) result.totalTokens = parts.total;
  const parsed = receiptMetadataSchema.safeParse(result);
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : undefined;
}

/** Streaming answers from OpenAI (Chat Completions) or Anthropic (Messages). Fixed hosts,
 * no redirects, bounded size and idle/total timeouts, secrets filtered from output. */
async function chatGenerate(provider: 'openai' | 'anthropic', key: string, model: string, input: Generate, guard: Guard,
  emit: (text: string) => void, request: typeof fetch, privateValues: string[], receipt?: (metadata: ReceiptMetadata) => void) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, guard.signal]);
  const cancel = () => controller.abort();
  const total = setTimeout(cancel, 90000);
  let idle = setTimeout(cancel, 45000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const filter = secretFilter(privateValues);
  const timing: { headersMs?: number; firstTokenMs?: number; thinking?: string } = {}, begun = performance.now();
  const maxTokens = input.maxTokens ?? 3000;
  try {
    const image = input.image;
    const started = performance.now();
    let response!: Response;
    if (provider === 'openai') {
      const ladder = openaiReasoningLadder(model);
      const known = openaiReasoningChoice.get(model);
      const post = (effort: string | undefined) => request('https://api.openai.com/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens,
          ...(effort ? { reasoning_effort: effort } : {}),
          // Reasoning models only accept their default temperature; chat models answer more steadily at 0.6.
          ...(ladder.length === 1 ? { temperature: 0.6 } : {}),
          messages: [
            { role: 'system', content: ANSWER_SYSTEM },
            { role: 'user', content: image ? [{ type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: 'high' } }] : input.prompt },
          ] }),
      });
      let used = 'default';
      for (const step of known === undefined ? ladder.map((_, index) => index) : [known]) {
        response = await post(ladder[step]);
        used = ladder[step] ?? 'default';
        if (response.status !== 400) { openaiReasoningChoice.set(model, step); break; }
        await response.body?.cancel().catch(() => undefined);
      }
      timing.thinking = used;
    } else {
      const post = (temperature: boolean) => request('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, system: ANSWER_SYSTEM, ...(temperature ? { temperature: 0.6 } : {}), messages: [
          { role: 'user', content: [...(image ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }] : []),
            { type: 'text', text: input.prompt }] },
        ] }),
      });
      response = await post(!anthropicNoTemperature.has(model));
      if (response.status === 400 && !anthropicNoTemperature.has(model)) {
        await response.body?.cancel().catch(() => undefined);
        response = await post(false);
        if (response.status !== 400) anthropicNoTemperature.add(model);
      }
    }
    guard.assertActive();
    timing.headersMs = Math.round(performance.now() - started);
    if (!response.ok || !response.body) { logAnswerFailure(provider, model, `http-${response.status}`, begun); await response.body?.cancel(); throw unavailable(); }
    reader = response.body.getReader();
    let buffer = '', totalBytes = 0, hasAnswer = false;
    const usage: { id?: string; input?: number; output?: number; thinking?: number; cached?: number; total?: number } = {};
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const event = (raw: string) => {
      guard.assertActive();
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim();
      if (!data || data === '[DONE]') return;
      const value = JSON.parse(data);
      if (value.error || value.type === 'error') throw unavailable();
      let text: unknown;
      if (provider === 'openai') {
        usage.id ??= value.id;
        const u = value.usage;
        if (u && typeof u === 'object') {
          const reasoning = countOf(u.completion_tokens_details?.reasoning_tokens) ?? 0, completion = countOf(u.completion_tokens);
          usage.input = countOf(u.prompt_tokens); usage.total = countOf(u.total_tokens);
          if (completion !== undefined) { usage.output = Math.max(0, completion - reasoning); usage.thinking = reasoning; }
          usage.cached = countOf(u.prompt_tokens_details?.cached_tokens);
        }
        const choice = value.choices?.[0];
        if (choice?.delta?.refusal || (choice?.finish_reason && !['stop', 'length'].includes(choice.finish_reason))) throw unavailable();
        text = choice?.delta?.content;
      } else {
        if (value.type === 'message_start') {
          const u = value.message?.usage ?? {};
          usage.id ??= value.message?.id;
          const cachedRead = countOf(u.cache_read_input_tokens) ?? 0;
          usage.input = (countOf(u.input_tokens) ?? 0) + cachedRead + (countOf(u.cache_creation_input_tokens) ?? 0);
          usage.cached = cachedRead;
        } else if (value.type === 'message_delta') {
          const output = countOf(value.usage?.output_tokens); if (output !== undefined) usage.output = output;
          if (value.delta?.stop_reason && !['end_turn', 'max_tokens', 'stop_sequence'].includes(value.delta.stop_reason)) throw unavailable();
        }
        text = value.type === 'content_block_delta' && value.delta?.type === 'text_delta' ? value.delta.text : undefined;
      }
      if (typeof text !== 'string' || !text) return;
      if (text.trim()) hasAnswer = true;
      const safe = filter.push(text);
      if (safe) { if (timing.firstTokenMs === undefined) timing.firstTokenMs = Math.round(performance.now() - begun); emit(safe); }
    };
    while (true) {
      guard.assertActive();
      const { done, value } = await reader.read();
      guard.assertActive();
      if (signal.aborted) throw unavailable();
      if (done) break;
      clearTimeout(idle); idle = setTimeout(cancel, 45000);
      totalBytes += value.byteLength;
      if (totalBytes > 2_000_000) throw unavailable();
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > 128000) throw unavailable();
        event(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (buffer.length > 128000) throw unavailable();
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    guard.assertActive();
    if (!hasAnswer) throw unavailable();
    const final = filter.push('', true); if (final) emit(final);
    const metadata = chatReceipt(usage); if (metadata) receipt?.(metadata);
    logAnswerTiming(provider, model, timing, begun);
  } catch {
    if (!guard.signal.aborted) logAnswerFailure(provider, model, timing.firstTokenMs === undefined ? (timing.headersMs === undefined ? 'no-reply-from-provider' : 'no-words-after-reply') : 'stream-stopped', begun);
    throw unavailable();
  }
  finally { clearTimeout(total); clearTimeout(idle); cancel(); await reader?.cancel().catch(() => undefined); }
}
