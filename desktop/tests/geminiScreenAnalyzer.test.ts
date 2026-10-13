import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiScreenAnalyzer, ScreenStreamSplitter } from '../src/main/screen/GeminiScreenAnalyzer';
import type { ScreenAnalysisRequest, ScreenAnalysisStreamEvent } from '../src/main/screen/ScreenAnalyzer';
import { SPOKEN_ANSWER_STYLE } from '../src/main/llm/spokenAnswerStyle';

const config = { apiKey: 'test', model: 'gemini-2.5-flash-lite', timeoutMs: 1_000 };
const analysis = {
  visibleApplication: 'Chrome', visibleText: 'Question text', codeOrProblem: '', errorMessages: [], constraints: [], summary: 'An interview question', confidence: 0.9,
};
const request: ScreenAnalysisRequest = {
  image: Buffer.from('image'), mimeType: 'image/png', sourceName: 'Chrome', capturedAt: '2026-01-01T00:00:00.000Z', question: 'Solve it', preserveSmallText: true,
  context: {
    session: { role: 'Engineer', company: 'Acme', interviewType: 'technical', language: 'English', answerStyle: 'Concise', answerLength: 'short', instructions: '', selectedModel: '' },
    recentConversation: [], resumeContext: [], jobContext: [], documentContext: [],
  },
};
const sse = (text: string, finishReason?: string): string => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;
const successResponse = (): Response => new Response(
  sse(`**Answer:** Use a map.\n<<<SIGMAROUND_SCREEN_CONTEXT>>>\n${JSON.stringify(analysis)}`, 'STOP'),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const unavailableResponse = (): Response => new Response('', { status: 503, headers: { 'Retry-After': '0' } });
const collect = async (analyzer: GeminiScreenAnalyzer): Promise<ScreenAnalysisStreamEvent[]> => {
  const events: ScreenAnalysisStreamEvent[] = [];
  for await (const event of analyzer.streamAnalysis(request, new AbortController().signal)) events.push(event);
  return events;
};

afterEach(() => vi.unstubAllGlobals());

describe('GeminiScreenAnalyzer streaming', () => {
  it('uses minimal thinking for Gemini 3 Flash without also sending a thinking budget', async () => {
    const fetchMock = vi.fn(async () => successResponse()); vi.stubGlobal('fetch', fetchMock);
    await collect(new GeminiScreenAnalyzer({ ...config, model: 'gemini-3.6-flash' }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const [endpoint, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).not.toContain('key=');
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe('test');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(body.contents[0].parts[0].text).toContain(SPOKEN_ANSWER_STYLE);
  });

  it('uses the exact session model for screenshots and refuses a disabled choice without a provider call', async () => {
    const fetchMock = vi.fn(async () => successResponse()); vi.stubGlobal('fetch', fetchMock);
    const selected = { ...request, context: { ...request.context, session: { ...request.context.session, selectedModel: 'gemini-session-choice' } } };
    const analyzer = new GeminiScreenAnalyzer(config, 'gemini-fallback', async (modelId) => modelId === 'gemini-session-choice');
    for await (const _event of analyzer.streamAnalysis(selected, new AbortController().signal)) { /* Consume the stream. */ }
    expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])).toContain('/gemini-session-choice:streamGenerateContent');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const disabled = new GeminiScreenAnalyzer(config, 'gemini-fallback', async () => false);
    await expect((async () => { for await (const _event of disabled.streamAnalysis(selected, new AbortController().signal)) { /* No events. */ } })()).rejects.toThrow('unavailable in Cluera');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a thought-only token exhaustion rather than silently completing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse('', 'MAX_TOKENS'))));
    await expect(collect(new GeminiScreenAnalyzer(config))).rejects.toThrow('before producing a visible answer');
  });
  it('yields first text while the HTTP body is still open, then appends and retains evidence', async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const iterator = new GeminiScreenAnalyzer(config).streamAnalysis(request, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    writer.enqueue(encoder.encode(sse('The issue is')));
    expect((await first).value).toEqual({ type: 'answer', text: 'The issue is' });
    const second = iterator.next();
    writer.enqueue(encoder.encode(sse(' caused by a missing dependency.')));
    expect((await second).value).toEqual({ type: 'answer', text: ' caused by a missing dependency.' });
    writer.enqueue(encoder.encode(sse(`\n<<<SIGMAROUND_SCREEN_CONTEXT>>>\n${JSON.stringify({ ...analysis, detectedLanguage: 'TypeScript', technologies: ['React'], currentTask: 'Fix the effect', uiDetails: 'Red error banner' })}`, 'STOP')));
    writer.close();
    const remaining: ScreenAnalysisStreamEvent[] = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
    expect(remaining.find(event => event.type === 'context')).toMatchObject({ context: { detectedLanguage: 'TypeScript', technologies: ['React'], currentTask: 'Fix the effect' } });
  });

  it('times out a stalled provider without waiting indefinitely', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    await expect(collect(new GeminiScreenAnalyzer({ ...config, timeoutMs: 20 }))).rejects.toThrow('timed out');
  });

  it('does not retransmit the screenshot after a partially streamed connection fails', async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const fetchMock = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetchMock);
    const iterator = new GeminiScreenAnalyzer(config).streamAnalysis(request, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next(); writer.enqueue(new TextEncoder().encode(sse('Visible partial answer')));
    expect((await first).value).toMatchObject({ text: 'Visible partial answer' });
    writer.error(new Error('Connection lost'));
    await expect(iterator.next()).rejects.toThrow('Connection lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retries a temporary 503, streams the answer, and returns structured context', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailableResponse()).mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    const events = await collect(new GeminiScreenAnalyzer(config));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'answer').map((event) => event.text).join('').trim()).toBe('**Answer:** Use a map.');
    expect(events.find((event) => event.type === 'context')).toMatchObject({ context: { sourceName: 'Chrome', summary: 'An interview question' } });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig).toMatchObject({ mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingBudget: 0 } });
  });

  it('keeps a split context marker out of the visible answer', () => {
    const splitter = new ScreenStreamSplitter();
    expect(splitter.push('Visible answer\n<<<SIGMAROUND_')).toBe('Visible answer\n');
    expect(splitter.push('SCREEN_CONTEXT>>>\n{"summary":"ok"}')).toBe('');
    expect(splitter.finish().contextText.trim()).toBe('{"summary":"ok"}');
  });

  it('returns a clear retry message after repeated 503 responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unavailableResponse()));
    await expect(collect(new GeminiScreenAnalyzer(config))).rejects.toThrow('temporarily unavailable after 4 attempts (503)');
  });

  it('does not spend more quota retrying a 429 response', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new GeminiScreenAnalyzer(config))).rejects.toThrow('quota or rate limit reached (429)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the working answer model when a screen override returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    const analyzer = new GeminiScreenAnalyzer(config, 'gemini-2.5-flash');
    const events = await collect(analyzer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('gemini-2.5-flash-lite');
    expect(String(fetchMock.mock.calls[1][0])).toContain('gemini-2.5-flash');
    expect(analyzer.name).toBe('gemini-2.5-flash');
    expect(events.some((event) => event.type === 'answer')).toBe(true);
  });
});
