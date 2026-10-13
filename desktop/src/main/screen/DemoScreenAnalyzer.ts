import type { ScreenAnalysisRequest, ScreenAnalysisStreamEvent, ScreenAnalyzer } from './ScreenAnalyzer';

export class DemoScreenAnalyzer implements ScreenAnalyzer {
  readonly name = 'Local screen demo';

  async *streamAnalysis(request: ScreenAnalysisRequest, signal: AbortSignal): AsyncIterable<ScreenAnalysisStreamEvent> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    request.onProviderRequest?.();
    request.onFirstToken?.();
    yield { type: 'answer', text: `**Direct answer:** This is the local screenshot demo for “${request.question}”.\n\n` };
    yield { type: 'answer', text: '- The image stayed in memory.\n- Configure Gemini to analyze the actual visible content.' };
    yield { type: 'context', context: {
      sourceName: request.sourceName, capturedAt: request.capturedAt, visibleApplication: 'Mock preview', visibleText: '',
      codeOrProblem: request.question || undefined, errorMessages: [], constraints: [],
      summary: 'Demo analysis is active. The screenshot was not sent to a provider.', confidence: 0.25,
    } };
  }
}
