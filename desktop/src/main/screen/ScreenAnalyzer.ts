import type { ContextChunk, ConversationTurn, ScreenContext, Session } from '../../shared/types';

export interface CompactScreenRequestContext {
  session: Pick<Session, 'role' | 'company' | 'interviewType' | 'language' | 'answerStyle' | 'answerLength' | 'instructions' | 'selectedModel'>;
  recentConversation: Array<Pick<ConversationTurn, 'speaker' | 'text'>>;
  resumeContext: ContextChunk[];
  jobContext: ContextChunk[];
  documentContext: ContextChunk[];
  priorScreenContext?: Pick<ScreenContext, 'sourceName' | 'summary' | 'codeOrProblem' | 'constraints' | 'errorMessages' | 'detectedLanguage' | 'technologies' | 'uiDetails' | 'currentTask'>;
}

export interface ScreenAnalysisRequest {
  image: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  sourceName: string;
  capturedAt: string;
  question: string;
  context: CompactScreenRequestContext;
  preserveSmallText: boolean;
  onProviderRequest?: () => void;
  onFirstToken?: () => void;
}

export type ScreenAnalysisStreamEvent =
  | { type: 'answer'; text: string }
  | { type: 'context'; context: ScreenContext };

export interface ScreenAnalyzer {
  readonly name: string;
  streamAnalysis(request: ScreenAnalysisRequest, signal: AbortSignal): AsyncIterable<ScreenAnalysisStreamEvent>;
}
