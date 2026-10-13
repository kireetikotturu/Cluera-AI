export type AnswerLength = 'short' | 'medium' | 'detailed';
export type InterviewType = 'technical' | 'behavioral' | 'mixed' | 'system-design' | 'coding';
export type DocumentType = 'resume' | 'job-description' | 'supporting' | 'round-context';
export type AudioSourceRole = 'remote_interviewer' | 'manual_interviewer' | 'local_candidate';
export type AudioSourceKind = 'system' | 'microphone' | 'manual';
export interface AudioSourceDescriptor {
  id: string;
  kind: AudioSourceKind;
  role: AudioSourceRole;
  label: string;
  canTriggerAnswers: boolean;
  meetingProvider?: 'Google Meet' | 'Microsoft Teams' | 'Other';
}
export type CopilotStatus =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'question-detected'
  | 'retrieving'
  | 'answering'
  | 'ready'
  | 'paused'
  | 'recovering'
  | 'error';

export type QuestionIntentName =
  | 'TECHNICAL_QUESTION'
  | 'BEHAVIORAL_QUESTION'
  | 'EXPERIENCE_QUESTION'
  | 'FOLLOW_UP'
  | 'CLARIFICATION'
  | 'MULTI_PART_QUESTION'
  | 'CODING_QUESTION'
  | 'SYSTEM_DESIGN'
  | 'GENERAL_QUESTION'
  | 'FEEDBACK'
  | 'SMALL_TALK'
  | 'CONTEXT_ONLY'
  | 'NO_ANSWER_NEEDED';

export interface Session {
  id: string;
  title: string;
  role: string;
  company: string;
  interviewType: InterviewType;
  language: string;
  answerStyle: string;
  answerLength: AnswerLength;
  jobDescription: string;
  resumeText: string;
  instructions: string;
  selectedModel: string;
  autoAnswer?: boolean;
  saveTranscript?: boolean;
  interviewUrl?: string;
  resumeFileName?: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionInput = Omit<Session, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export interface DocumentRecord {
  id: string;
  sessionId: string;
  name: string;
  type: DocumentType;
  mimeType: string;
  text: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ExtractedDocument {
  name: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
  libraryFileId?: string;
}

export type LibraryFileCategory = 'resume' | 'supporting';

export interface LibraryFile {
  id: string;
  category: LibraryFileCategory;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  available: boolean;
}

export interface LibraryFileContent extends LibraryFile {
  text: string;
  libraryFileId: string;
}

export interface ContextChunk {
  id: string;
  sessionId: string;
  documentId: string;
  documentType: DocumentType;
  section: string;
  page: number | null;
  chunkIndex: number;
  text: string;
  score?: number;
}

export interface ConversationTurn {
  roundId?: string;
  id: string;
  sessionId: string;
  speaker: 'interviewer' | 'candidate' | 'copilot';
  text: string;
  createdAt: string;
  questionId?: string;
  sourceId?: string;
  sourceKind?: AudioSourceKind;
  sourceRole?: AudioSourceRole;
  canTriggerAnswers?: boolean;
}

export interface QuestionRecord {
  roundId?: string;
  id: string;
  sessionId: string;
  text: string;
  intent: QuestionIntentName;
  confidence: number;
  createdAt: string;
}

export interface AnswerRecord {
  id: string;
  sessionId: string;
  questionId: string;
  text: string;
  model: string;
  latencyMs: number;
  createdAt: string;
}

export interface SessionDetail {
  rounds?: InterviewRound[];
  session: Session;
  documents: DocumentRecord[];
  conversation: ConversationTurn[];
  questions: Array<QuestionRecord & { answer?: AnswerRecord }>;
}

export interface InterviewRound {
  id: string;
  sessionId: string;
  number: number;
  note: string;
  startedAt: string;
  endedAt: string | null;
  state: 'open' | 'completed' | 'interrupted';
  summary: string;
}

export interface RoundHistory {
  conversation: ConversationTurn[];
  questions: Array<QuestionRecord & { answer?: AnswerRecord }>;
  hasMore: boolean;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  sourceId: string;
  sourceKind: AudioSourceKind;
  sourceRole: AudioSourceRole;
  canTriggerAnswers: boolean;
  confidence: number;
  timestamp: number;
}

export interface TurnEvent {
  type: 'start' | 'eager-end' | 'resume' | 'end';
  transcript: string;
  sourceId: string;
  sourceKind: AudioSourceKind;
  sourceRole: AudioSourceRole;
  canTriggerAnswers: boolean;
  timestamp: number;
}

export interface ScreenContext {
  sourceName: string;
  capturedAt: string;
  visibleApplication?: string;
  visibleText: string;
  codeOrProblem?: string;
  errorMessages: string[];
  constraints: string[];
  summary: string;
  confidence: number;
  detectedLanguage?: string;
  technologies?: string[];
  uiDetails?: string;
  currentTask?: string;
}

export type ScreenAnalysisApprovalResult =
  | { ok: true; context: ScreenContext }
  | { ok: false; error: string };

export interface ScreenCapturePreview {
  id: string;
  sourceId: string;
  sourceName: string;
  capturedAt: string;
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
  sizeBytes: number;
  kind?: ShotKind;
  width?: number;
  height?: number;
}

export type ShotKind = 'tab' | 'screen' | 'area';
export interface ShotRequest { kind: ShotKind; sourceId?: string; keepAppVisible?: boolean }

export interface SelectedScreenSource {
  id: string;
  name: string;
  kind?: ShotKind;
}

export interface DesktopCaptureSource { id: string; name: string; thumbnailDataUrl: string; }

export interface QuestionIntent {
  isAnswerNeeded: boolean;
  intent: QuestionIntentName;
  confidence: number;
  question: string;
  isComplete: boolean;
  requiresMoreContext: boolean;
}

export interface AnswerContext {
  question: string;
  intent: QuestionIntentName;
  recentConversation: ConversationTurn[];
  resumeContext: ContextChunk[];
  jobContext: ContextChunk[];
  documentContext: ContextChunk[];
  screenContext?: ScreenContext;
  instructions: string;
  session: Session;
}

export interface TelemetrySnapshot {
  turnDetectionLatency: number;
  intentLatency: number;
  retrievalLatency: number;
  llmTimeToFirstToken: number;
  totalQuestionToAnswerLatency: number;
}

export interface ProviderStatus {
  providerMode?: 'managed' | 'byok';
  demoMode: boolean;
  development?: boolean;
  deepgramConfigured: boolean;
  geminiConfigured: boolean;
  databasePath: string;
  models: string[];
  modelOptions?: ProviderModelOption[];
  deepgramModelOptions?: ProviderModelOption[];
  defaultGeminiModel?: string;
  defaultDeepgramModel?: string;
  screenAnalysisEnabled: boolean;
}

export type ProviderName = 'gemini' | 'deepgram';

export interface ProviderModelOption {
  provider: ProviderName;
  modelId: string;
  displayName: string;
  description: string;
}

export interface ProviderCredentialState {
  provider: ProviderName;
  configured: boolean;
  updatedAt?: string;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  overlayOpacity: number;
  privateMode: boolean;
  debugMode: boolean;
  demoMode: boolean;
  shortcuts: Record<string, string>;
  geminiModel?: string;
  deepgramModel?: string;
}

export interface UpdateStatus {
  state: 'unavailable' | 'current' | 'optional' | 'recommended' | 'required';
  message: string;
  version?: string;
  minimumSupportedVersion?: string;
  releaseNotes?: string;
  installedVersion?: string;
  channel?: 'stable' | 'beta' | 'cluera-beta';
  sessionActive?: boolean;
  installPhase?: 'idle' | 'downloading' | 'verifying' | 'launching';
  downloadedBytes?: number;
  totalBytes?: number;
  installError?: string;
}

export interface SessionSummary {
  totalQuestions: number;
  averageLatencyMs: number;
  topics: string[];
  startedAt: string;
  lastActivityAt: string;
}

export interface AnswerRequest {
  sessionId: string;
  question: string;
  mode?: 'default' | 'shorter' | 'longer' | 'technical' | 'conversational' | 'star';
  origin?: 'typed' | 'transcript';
}

export interface UploadedDocumentInput {
  sessionId: string;
  type: DocumentType;
}

export interface AppEventMap {
  'screen:quick-shot': null;
  'copilot:status': { status: CopilotStatus; message?: string };
  'transcript:partial': TranscriptEvent;
  'transcript:final': TranscriptEvent;
  'screen:capture-ready': ScreenCapturePreview;
  'screen:context': ScreenContext | null;
  'question:detected': QuestionIntent;
  'question:resolved': { questionId: string; question: QuestionIntent };
  'answer:started': { questionId: string; captureId?: string };
  'answer:token': { questionId: string; token: string };
  'answer:completed': { questionId: string; answer: AnswerRecord; telemetry: TelemetrySnapshot };
  'app:error': { title: string; message: string; recoverable: boolean };
}

export type AppEventName = keyof AppEventMap;
