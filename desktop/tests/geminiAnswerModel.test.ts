import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerContext, Session } from '../src/shared/types';
import { GeminiAnswerModel, parseGeminiSseChunk, parseGeminiSseEvent } from '../src/main/llm/GeminiAnswerModel';
import { PromptBuilder } from '../src/main/llm/PromptBuilder';

const session: Session = {
  id: '1', title: 'Gemini stream', role: 'Engineer', company: '', interviewType: 'technical', language: 'English',
  answerStyle: 'Natural', answerLength: 'short', jobDescription: '', resumeText: '', instructions: '', selectedModel: 'gemini', createdAt: '', updatedAt: '',
};
const context: AnswerContext = {
  question: 'How would you secure an API?', intent: 'TECHNICAL_QUESTION', recentConversation: [], resumeContext: [],
  jobContext: [], documentContext: [], instructions: '', session,
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('GeminiAnswerModel streaming', () => {
  it('parses SSE data lines with either LF or CRLF newlines', () => {
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Rendered answer' }] } }] });
    expect(parseGeminiSseEvent(`data: ${json}\r\n`)).toBe('Rendered answer');
    expect(parseGeminiSseEvent(`data:${json}\n`)).toBe('Rendered answer');
  });

  it('emits CRLF-delimited events and the final event without a trailing separator', async () => {
    const encoder = new TextEncoder();
    const first = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'First ' }] } }] });
    const second = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${first}\r\n\r\n`));
        controller.enqueue(encoder.encode(`data: ${second}`));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 1_000 }, new PromptBuilder());
    let result = '';
    for await (const token of model.streamAnswer(context, new AbortController().signal)) result += token;
    expect(result).toBe('First answer');
  });

  it('reserves the output budget for the spoken answer on Gemini 2.5 Flash', async () => {
    const encoder = new TextEncoder();
    const event = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Complete introduction.' }] }, finishReason: 'STOP' }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); controller.close(); },
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-2.5-flash', timeoutMs: 1_000 }, new PromptBuilder());
    let result = '';
    for await (const token of model.streamAnswer({ ...context, session: { ...session, selectedModel: 'gemini-2.5-flash' } }, new AbortController().signal)) result += token;
    const request = fetchMock.mock.calls[0][1];
    if (!request) throw new Error('Expected Gemini request options.');
    const payload = JSON.parse(String(request.body)) as { generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number } } };
    expect(result).toBe('Complete introduction.');
    expect(payload.generationConfig).toMatchObject({ maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-2.5-flash:');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('key=');
    expect((request.headers as Record<string, string>)['x-goog-api-key']).toBe('test');
  });

  it('reports a non-stop finish reason instead of treating a fragment as complete', async () => {
    const event = JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello! I'm a full-stack " }] }, finishReason: 'MAX_TOKENS' }] });
    expect(parseGeminiSseChunk(`data: ${event}`)).toEqual({ text: "Hello! I'm a full-stack ", finishReason: 'MAX_TOKENS' });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); controller.close(); },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-2.5-flash', timeoutMs: 1_000 }, new PromptBuilder());
    await expect(async () => {
      for await (const _token of model.streamAnswer(context, new AbortController().signal)) { /* drain */ }
    }).rejects.toThrow('MAX_TOKENS');
  });

  it('redacts a provider echo of the customer credential from errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Request rejected for test-secret-credential', { status: 403 })));
    const model = new GeminiAnswerModel({ apiKey: 'test-secret-credential', model: 'gemini-test', timeoutMs: 1_000 }, new PromptBuilder());
    let message = '';
    try {
      for await (const _token of model.streamAnswer(context, new AbortController().signal)) { /* drain */ }
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('403');
    expect(message).not.toContain('test-secret-credential');
  });

  it('times out stalled response headers and aborts the underlying request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 25 }, new PromptBuilder());
    const next = model.streamAnswer(context, new AbortController().signal)[Symbol.asyncIterator]().next();
    const timedOut = expect(next).rejects.toThrow(/response headers timed out/i);
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('keeps the first visible text but times out a stalled stream chunk', async () => {
    vi.useFakeTimers();
    const event = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Visible partial answer' }] } }] });
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`)); },
      cancel: canceled,
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 25 }, new PromptBuilder());
    const iterator = model.streamAnswer(context, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('Visible partial answer');
    const next = iterator.next();
    const timedOut = expect(next).rejects.toThrow(/response stream timed out/i);
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('honors external cancellation while headers are pending', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const abort = new AbortController();
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 1_000 }, new PromptBuilder());
    const next = model.streamAnswer(context, abort.signal)[Symbol.asyncIterator]().next();
    abort.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('honors external cancellation after partial text has streamed', async () => {
    const event = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Already visible' }] } }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`)); },
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const abort = new AbortController();
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 1_000 }, new PromptBuilder());
    const iterator = model.streamAnswer(context, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('Already visible');
    const next = iterator.next();
    const canceled = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await canceled;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('continues a successful stream when each chunk arrives before the inactivity deadline', async () => {
    vi.useFakeTimers();
    const first = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'First ' }] } }] });
    const second = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        setTimeout(() => controller.enqueue(encoder.encode(`data: ${first}\n\n`)), 5);
        setTimeout(() => controller.enqueue(encoder.encode(`data: ${second}\n\n`)), 15);
        setTimeout(() => controller.close(), 25);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const model = new GeminiAnswerModel({ apiKey: 'test', model: 'gemini-test', timeoutMs: 20 }, new PromptBuilder());
    const result = (async () => {
      let text = '';
      for await (const token of model.streamAnswer(context, new AbortController().signal)) text += token;
      return text;
    })();
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe('First answer');
  });
});
