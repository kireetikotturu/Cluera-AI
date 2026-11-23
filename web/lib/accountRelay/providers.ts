import WebSocket from 'ws';
import { DEEPGRAM_MODEL, GEMINI_MODEL, secretFilter, type Generate } from './protocol';
import {providerReceiptMetadata} from '../aiProviders/telemetry';
import type {ReceiptMetadata} from '../aiProviders/usageMetadata';

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
        return chatGenerate(dependencies.textProvider, key, selected, input, guard, emit, request, privateValues);
      }
      if(!secrets.geminiKey)throw unavailable();
      const selectedModel = dependencies.resolveModel ? await dependencies.resolveModel(input) : GEMINI_MODEL;
      if (!dependencies.resolveModel && input.modelId && input.modelId !== GEMINI_MODEL) throw unavailable();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(selectedModel)) throw unavailable();
      guard.assertActive();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, guard.signal]);
      const cancel = () => controller.abort();
      const total = setTimeout(cancel, 60000);
      let idle = setTimeout(cancel, 15000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const filter = secretFilter(privateValues);
      try {
        const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent?alt=sse`, {
          method: 'POST', redirect: 'error', signal, cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': secrets.geminiKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input.prompt },
            ...(input.image ? [{ inlineData: input.image }] : [])] }],
          generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 3000, thinkingConfig: { thinkingLevel: 'minimal' } } }),
        });
        guard.assertActive();
        if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable(); }
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
            if (text) emit(text);
          }
        };
        while (true) {
          guard.assertActive();
          const { done, value } = await reader.read();
          guard.assertActive();
          if (signal.aborted) throw unavailable();
          if (done) break;
          clearTimeout(idle); idle = setTimeout(cancel, 15000);
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
      } catch { throw unavailable(); }
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

const ANSWER_SYSTEM = 'You are Cluera, a concise interview copilot. Answer clearly and directly.';
/** Streaming answers from OpenAI (Chat Completions) or Anthropic (Messages). Fixed hosts,
 * no redirects, bounded size and idle/total timeouts, secrets filtered from output. */
async function chatGenerate(provider: 'openai' | 'anthropic', key: string, model: string, input: Generate, guard: Guard,
  emit: (text: string) => void, request: typeof fetch, privateValues: string[]) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, guard.signal]);
  const cancel = () => controller.abort();
  const total = setTimeout(cancel, 60000);
  let idle = setTimeout(cancel, 20000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const filter = secretFilter(privateValues);
  try {
    const image = input.image;
    const response = provider === 'openai'
      ? await request('https://api.openai.com/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, stream: true, max_completion_tokens: 3000, messages: [
          { role: 'system', content: ANSWER_SYSTEM },
          { role: 'user', content: image ? [{ type: 'text', text: input.prompt },
            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] : input.prompt },
        ] }),
      })
      : await request('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, stream: true, max_tokens: 3000, system: ANSWER_SYSTEM, messages: [
          { role: 'user', content: [...(image ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }] : []),
            { type: 'text', text: input.prompt }] },
        ] }),
      });
    guard.assertActive();
    if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable(); }
    reader = response.body.getReader();
    let buffer = '', totalBytes = 0, hasAnswer = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const event = (raw: string) => {
      guard.assertActive();
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim();
      if (!data || data === '[DONE]') return;
      const value = JSON.parse(data);
      if (value.error || value.type === 'error') throw unavailable();
      const text = provider === 'openai' ? value.choices?.[0]?.delta?.content
        : value.type === 'content_block_delta' && value.delta?.type === 'text_delta' ? value.delta.text : undefined;
      if (typeof text !== 'string' || !text) return;
      if (text.trim()) hasAnswer = true;
      const safe = filter.push(text);
      if (safe) emit(safe);
    };
    while (true) {
      guard.assertActive();
      const { done, value } = await reader.read();
      guard.assertActive();
      if (signal.aborted) throw unavailable();
      if (done) break;
      clearTimeout(idle); idle = setTimeout(cancel, 20000);
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
  } catch { throw unavailable(); }
  finally { clearTimeout(total); clearTimeout(idle); cancel(); await reader?.cancel().catch(() => undefined); }
}
