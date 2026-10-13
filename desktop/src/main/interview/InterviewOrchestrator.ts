import type {
  AnswerRequest, AppEventMap, AppEventName, AudioSourceDescriptor, QuestionIntent, ScreenContext, Session, TranscriptEvent,
} from '../../shared/types';
import type { AppConfig } from '../config/appConfig';
import { ContextBuilder } from '../context/ContextBuilder';
import { Repositories } from '../database/Repositories';
import type { AnswerModel } from '../llm/AnswerModel';
import type { OptimizedScreenImage } from '../screen/ScreenImageOptimizer';
import type { ScreenAnalyzer } from '../screen/ScreenAnalyzer';
import { DeepgramRecognizer } from '../stt/DeepgramRecognizer';
import type { SpeechRecognizer } from '../stt/SpeechRecognizer';
import { Telemetry } from '../telemetry/Telemetry';
import { IntentDetector } from './IntentDetector';
import { TurnGate } from './TurnGate';

type Emitter = <K extends AppEventName>(name: K, payload: AppEventMap[K]) => void;
const CANDIDATE_SOURCE: AudioSourceDescriptor = {
  id: 'candidate-microphone', kind: 'microphone', role: 'local_candidate',
  label: 'Candidate microphone', canTriggerAnswers: false,
};
const normalizeQuestionText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SCREEN_QUESTION_FALLBACK = 'Answer the question detected from the screenshot';

const cleanScreenQuestion = (text: string): string => text
  .replace(/^\s*(?:question|task|prompt)\s*:\s*/i, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Chooses a short user-facing question from the structured screen evidence. */
export function resolveScreenQuestion(context: ScreenContext, fallback = SCREEN_QUESTION_FALLBACK): string {
  const evidence = [context.currentTask, context.codeOrProblem, context.visibleText]
    .filter((value): value is string => Boolean(value?.trim()));
  for (const value of evidence) {
    const questionLines = value.split(/[\r\n]+/).map(cleanScreenQuestion)
      .filter((line) => line.length >= 6 && line.length <= 320 && line.includes('?'));
    if (questionLines.length) return questionLines[questionLines.length - 1].slice(0, 320);
  }
  for (const value of [context.currentTask, context.codeOrProblem]) {
    const candidate = cleanScreenQuestion(value ?? '');
    if (candidate.length >= 6 && candidate.length <= 240 && !/[{};]/.test(candidate)) return candidate;
  }
  return cleanScreenQuestion(fallback).slice(0, 320) || SCREEN_QUESTION_FALLBACK;
}

export function mergeFinalTranscriptText(current: string, incoming: string): string {
  const previous = current.trim().replace(/\s+/g, ' ');
  const next = incoming.trim().replace(/\s+/g, ' ');
  if (!previous) return next;
  if (!next || previous === next || previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next;
  const previousWords = previous.split(' ');
  const nextWords = next.split(' ');
  const maximumOverlap = Math.min(12, previousWords.length, nextWords.length);
  for (let size = maximumOverlap; size > 0; size -= 1) {
    if (previousWords.slice(-size).join(' ').toLowerCase() === nextWords.slice(0, size).join(' ').toLowerCase()) {
      return [...previousWords, ...nextWords.slice(size)].join(' ');
    }
  }
  return `${previous} ${next}`;
}

export const mergeFinalCandidateText = mergeFinalTranscriptText;

export class InterviewOrchestrator {
  private recognizer: SpeechRecognizer | null = null;
  private candidateRecognizer: SpeechRecognizer | null = null;
  private candidateRecognizerUnavailable = false;
  private latestQuestionId: string | undefined;
  private candidatePendingQuestionId: string | null | undefined;
  private candidateTurnId: string | undefined;
  private candidateTurnQuestionId: string | null | undefined;
  private candidateTurnText = '';
  private session: Session | null = null;
  private paused = false;
  private answerAbort: AbortController | null = null;
  private answerInterruptible = true;
  private activeQuestionText = '';
  private lastQuestion = '';
  private autoAnswerEnabled = false;
  private interactionEnabled = true;
  private pendingInterviewerTranscript = '';
  private source: AudioSourceDescriptor | null = null;
  private screenContext: ScreenContext | undefined;
  private screenContextSessionId: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repositories: Repositories,
    private readonly intentDetector: IntentDetector,
    private readonly turnGate: TurnGate,
    private readonly contextBuilder: ContextBuilder,
    private readonly model: AnswerModel,
    private readonly emit: Emitter,
    private readonly accountProviders?: { recognizer(source: AudioSourceDescriptor): SpeechRecognizer; stop(): void },
  ) {}

  async start(sessionId: string, source: AudioSourceDescriptor, interactionEnabled = true): Promise<void> {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new Error('Session not found.');
    const retainedScreenContext = this.session?.id === sessionId ? this.screenContext : undefined;
    await this.stop();
    this.session = session;
    this.interactionEnabled = Boolean(interactionEnabled);
    this.screenContext = retainedScreenContext;
    this.screenContextSessionId = retainedScreenContext ? sessionId : undefined;
    this.emit('screen:context', retainedScreenContext ?? null);
    this.source = source;
    this.lastQuestion = '';
    this.pendingInterviewerTranscript = '';
    this.activeQuestionText = '';
    this.latestQuestionId = undefined;
    this.candidatePendingQuestionId = undefined;
    this.candidateTurnId = undefined;
    this.candidateTurnQuestionId = undefined;
    this.candidateTurnText = '';
    this.paused = false;
    this.candidateRecognizerUnavailable = false;
    this.latestQuestionId = undefined;
    this.candidatePendingQuestionId = undefined;
    this.candidateTurnId = undefined;
    this.candidateTurnQuestionId = undefined;
    this.candidateTurnText = '';
    this.repositories.saveAudioSource(sessionId, source);
    this.repositories.addEvent(sessionId, 'SESSION_STARTED', { source });
    this.emit('copilot:status', { status: 'preparing', message: 'Preparing context' });
    if (!this.accountProviders && !this.config.deepgram.apiKey && !this.config.deepgram.managed) {
      this.emit('copilot:status', { status: 'listening', message: 'Demo mode — type a question below' });
      return;
    }
    const recognizer = this.accountProviders?.recognizer(source) ?? new DeepgramRecognizer(this.config.deepgram, source);
    this.recognizer = recognizer;
    recognizer.onPartialTranscript((event) => {
      if (this.paused) return;
      if (this.interactionEnabled && event.canTriggerAnswers && this.autoAnswerEnabled) this.turnGate.update(event.text, 'partial');
      this.emit('transcript:partial', this.interviewerTranscriptForDisplay(event));
      if (!this.answerAbort) this.emit('copilot:status', { status: 'listening', message: this.interactionEnabled ? 'Interviewer speaking' : 'Device check - interviewer audio detected' });
    });
    recognizer.onFinalTranscript((event) => {
      if (!this.paused && event.text) this.acceptFinalTranscript(this.interviewerTranscriptForDisplay(event));
    });
    recognizer.onTurnEvent((event) => {
      if (this.paused) return;
      if (!this.interactionEnabled) { this.turnGate.reset(); return; }
      if (event.type === 'resume') { if (this.answerInterruptible) this.answerAbort?.abort(); this.lastQuestion = ''; this.turnGate.update(event.transcript, 'resume'); return; }
      if (event.type === 'end') {
        if (!event.canTriggerAnswers) return;
        if (!this.autoAnswerEnabled) {
          this.turnGate.reset();
          if (event.transcript.trim() && this.session) this.repositories.addTurn(this.session.id, 'interviewer', event.transcript.trim(), this.source ?? undefined);
          if (!this.answerAbort) this.emit('copilot:status', { status: 'listening', message: 'Interviewer turn captured — press Send when the question is complete' });
          return;
        }
        if (!this.answerAbort) this.emit('copilot:status', { status: 'listening', message: 'Interviewer turn complete — checking for a question' });
        const gate = this.turnGate.update(event.transcript, 'end');
        if (gate.decision === 'ANSWER_NOW') void this.processQuestion(gate.transcript);
        else if (event.transcript.trim() && this.session) this.repositories.addTurn(this.session.id, 'interviewer', event.transcript.trim(), this.source ?? undefined);
      }
    });
    recognizer.onError((error) => this.emit('app:error', { title: 'Transcription connection', message: error.message, recoverable: true }));
    await recognizer.start();
    this.repositories.addEvent(sessionId, 'STT_CONNECTED');
    this.emit('copilot:status', { status: 'listening', message: this.interactionEnabled ? 'Listening to interviewer and candidate' : 'Device check - AI disabled until Start' });
  }

  async stop(): Promise<void> {
    // Ignore late transcription callbacks while async socket closure settles.
    this.paused = true;
    this.turnGate.reset();
    this.answerAbort?.abort();
    this.answerAbort = null;
    this.accountProviders?.stop();
    this.activeQuestionText = '';
    this.pendingInterviewerTranscript = '';
    await Promise.all([this.recognizer?.stop(), this.candidateRecognizer?.stop()]);
    if (this.session) {
      this.repositories.addEvent(this.session.id, 'SESSION_STOPPED');
      this.repositories.clearTransientTurns(this.session.id);
    }
    this.recognizer = null;
    this.candidateRecognizer = null;
    this.candidateRecognizerUnavailable = false;
    this.source = null;
    this.interactionEnabled = true;
    this.screenContext = undefined;
    this.screenContextSessionId = undefined;
    this.emit('screen:context', null);
    this.session = null;
    this.turnGate.reset();
    this.emit('copilot:status', { status: 'idle' });
  }

  pause(value: boolean): void {
    this.paused = value;
    this.emit('copilot:status', { status: value ? 'paused' : 'listening', message: value ? 'Listening paused' : 'Listening resumed' });
  }

  setAutoAnswerEnabled(enabled: boolean): boolean {
    const next = Boolean(enabled);
    if (next !== this.autoAnswerEnabled) {
      this.autoAnswerEnabled = next;
      this.pendingInterviewerTranscript = '';
      this.turnGate.reset();
    }
    return this.autoAnswerEnabled;
  }

  setInteractionEnabled(enabled: boolean): boolean {
    this.interactionEnabled = Boolean(enabled);
    this.pendingInterviewerTranscript = '';
    this.lastQuestion = '';
    this.activeQuestionText = '';
    this.latestQuestionId = undefined;
    this.candidatePendingQuestionId = undefined;
    this.candidateTurnId = undefined;
    this.candidateTurnQuestionId = undefined;
    this.candidateTurnText = '';
    this.turnGate.reset();
    if (!this.interactionEnabled) {
      this.answerAbort?.abort();
      this.answerAbort = null;
      if (this.session) this.repositories.clearTransientTurns(this.session.id);
    }
    this.emit('copilot:status', {
      status: this.session ? 'listening' : 'idle',
      message: this.session
        ? this.interactionEnabled ? 'Interview started' : 'Device check - AI disabled until Start'
        : undefined,
    });
    return this.interactionEnabled;
  }

  sendAudio(sourceId: 'system' | 'candidate', chunk: Buffer): void {
    if (this.paused) return;
    if (sourceId === 'candidate') this.ensureCandidateRecognizer()?.sendAudio(chunk);
    else this.recognizer?.sendAudio(chunk);
  }

  private ensureCandidateRecognizer(): SpeechRecognizer | null {
    if (this.candidateRecognizer) return this.candidateRecognizer;
    if (this.candidateRecognizerUnavailable) return null;
    const owningSession = this.session;
    if (!owningSession || (!this.accountProviders && !this.config.deepgram.apiKey && !this.config.deepgram.managed)) return null;
    const candidateRecognizer = this.accountProviders?.recognizer(CANDIDATE_SOURCE) ?? new DeepgramRecognizer(this.config.deepgram, CANDIDATE_SOURCE);
    this.candidateRecognizer = candidateRecognizer;
    candidateRecognizer.onPartialTranscript((event) => {
      if (!this.paused && this.session?.id === owningSession.id) {
        if (this.interactionEnabled) this.beginCandidateSpeech();
        this.emit('transcript:partial', event);
      }
    });
    candidateRecognizer.onFinalTranscript((event) => {
      if (this.paused || !event.text || this.session?.id !== owningSession.id) return;
      this.emit('transcript:final', event);
      if (this.interactionEnabled) this.persistCandidateFinal(event.text, event.confidence);
    });
    candidateRecognizer.onTurnEvent((event) => {
      if (this.interactionEnabled && (event.type === 'start' || event.type === 'resume')) this.beginCandidateSpeech();
      if (event.type === 'end') this.candidatePendingQuestionId = undefined;
    });
    candidateRecognizer.onError((error) => this.emit('app:error', {
      title: 'Candidate microphone transcription', message: error.message, recoverable: true,
    }));
    void candidateRecognizer.start().then(() => {
      if (this.candidateRecognizer === candidateRecognizer && this.session?.id === owningSession.id) {
        this.repositories.addEvent(owningSession.id, 'CANDIDATE_STT_CONNECTED');
      }
    }).catch(async (error: unknown) => {
      await candidateRecognizer.stop();
      if (this.candidateRecognizer !== candidateRecognizer) return;
      this.candidateRecognizer = null;
      this.candidateRecognizerUnavailable = true;
      this.emit('app:error', {
        title: 'Candidate microphone transcription',
        message: error instanceof Error ? error.message : 'Candidate transcription could not start.',
        recoverable: true,
      });
    });
    return candidateRecognizer;
  }

  async injectMockTranscript(source: AudioSourceDescriptor, text: string, isFinal = true): Promise<void> {
    if (!this.session) throw new Error('Start an interview before injecting a transcript.');
    const event: TranscriptEvent = { text: text.trim(), isFinal, sourceId: source.id, sourceKind: source.kind,
      sourceRole: source.role, canTriggerAnswers: source.canTriggerAnswers, confidence: 1, timestamp: Date.now() };
    if (!isFinal) {
      if (this.interactionEnabled && source.role === 'local_candidate') this.beginCandidateSpeech();
      this.emit('transcript:partial', this.interviewerTranscriptForDisplay(event));
      return;
    }
    this.acceptFinalTranscript(this.interviewerTranscriptForDisplay(event));
    if (!this.interactionEnabled) return;
    if (source.role === 'local_candidate') {
      if (event.text) {
        this.beginCandidateSpeech();
        this.persistCandidateFinal(event.text, event.confidence, source);
        this.candidatePendingQuestionId = undefined;
      }
      return;
    }
    if (!source.canTriggerAnswers || !event.text) return;
    if (!this.autoAnswerEnabled) {
      this.turnGate.reset();
      this.repositories.addTurn(this.session.id, 'interviewer', event.text, source);
      this.emit('copilot:status', { status: 'listening', message: 'Interviewer turn captured — press Send when the question is complete' });
      return;
    }
    const gate = this.turnGate.update(event.text, 'end');
    if (gate.decision === 'ANSWER_NOW') await this.processQuestion(gate.transcript);
    else if (this.session) this.repositories.addTurn(this.session.id, 'interviewer', event.text, source);
  }

  setScreenContext(context: ScreenContext | undefined, sessionId?: string): void {
    this.screenContext = context;
    const ownerSessionId = sessionId ?? this.session?.id;
    this.screenContextSessionId = context ? ownerSessionId : undefined;
    if (context && ownerSessionId) this.repositories.saveScreenContext(ownerSessionId, context);
    this.emit('screen:context', context ?? null);
  }

  async answer(input: AnswerRequest): Promise<boolean> {
    const session = this.repositories.getSession(input.sessionId);
    if (!session) throw new Error('Session not found.');
    if (this.session && !this.interactionEnabled) throw new Error('Click Start before sending a question to AI.');
    if (this.screenContextSessionId && this.screenContextSessionId !== session.id) this.setScreenContext(undefined);
    this.session = session;
    const isPlainManualAnswer = !input.mode || input.mode === 'default';
    const isUntouchedTranscript = input.origin !== 'typed';
    const normalizedInput = normalizeQuestionText(input.question);
    if (isPlainManualAnswer && isUntouchedTranscript && (
      (this.answerAbort && normalizeQuestionText(this.activeQuestionText) === normalizedInput)
      || this.repositories.hasCompletedAnswerForQuestion(session.id, input.question)
    )) return false;
    const capturedTranscriptWasSaved = input.origin === 'transcript'
      && Boolean(this.pendingInterviewerTranscript.trim())
      && normalizeQuestionText(this.pendingInterviewerTranscript) === normalizedInput;
    if (input.origin) this.pendingInterviewerTranscript = '';
    const suffix = {
      default: '', shorter: ' Keep the answer much shorter.', longer: ' Expand the answer with useful detail.',
      technical: ' Make the answer more technical.', conversational: ' Make the answer more conversational.', star: ' Use STAR structure.',
    }[input.mode ?? 'default'];
    const manualSource: AudioSourceDescriptor = { id: 'manual', kind: 'manual', role: 'manual_interviewer', label: 'Typed question', canTriggerAnswers: true };
    if (!capturedTranscriptWasSaved) this.repositories.addTurn(session.id, 'interviewer', input.question, manualSource);
    return this.processQuestion(`${input.question}${suffix}`, input.question, true, true, false);
  }

  async answerFromScreen(input: {
    sessionId: string;
    captureId?: string;
    question: string;
    displayQuestion?: string;
    sourceName: string;
    capturedAt: string;
    optimizedImage: Promise<OptimizedScreenImage>;
    analyzer: ScreenAnalyzer;
    signal: AbortSignal;
    onTiming?: (milestone: 'rag-start' | 'rag-complete' | 'gemini-request-start' | 'first-token' | 'full-response-complete') => void;
  }): Promise<ScreenContext> {
    const session = this.repositories.getSession(input.sessionId);
    if (!session) throw new Error('Session not found.');
    if (this.session && !this.interactionEnabled) throw new Error('Click Start before analyzing a screenshot with AI.');
    if (this.screenContextSessionId && this.screenContextSessionId !== session.id) this.setScreenContext(undefined);
    input.signal.throwIfAborted();
    this.session = session;
    const instruction = input.question.trim();
    if (!instruction) throw new Error('Describe what Gemini should do with this screenshot.');
    let question = cleanScreenQuestion(input.displayQuestion ?? '') || SCREEN_QUESTION_FALLBACK;

    const telemetry = new Telemetry();
    telemetry.mark('questionStart');
    telemetry.mark('intentStart');
    let intent = this.intentDetector.detect(question);
    telemetry.mark('intentEnd');
    if (!intent.isComplete || !intent.isAnswerNeeded) {
      intent = { ...intent, question, isComplete: true, isAnswerNeeded: true, intent: 'GENERAL_QUESTION', confidence: 1 };
    }
    const screenTurn = this.repositories.addTurn(session.id, 'interviewer', question, {
      id: 'approved-screen', kind: 'manual', role: 'manual_interviewer', label: 'Approved screenshot task', canTriggerAnswers: true,
    });
    this.emit('question:detected', { ...intent, question });
    this.emit('copilot:status', { status: 'question-detected', message: 'Approved screenshot' });
    const record = this.repositories.addQuestion(session.id, { ...intent, question });
    this.latestQuestionId = record.id;
    this.repositories.addEvent(session.id, 'QUESTION_DETECTED', { intent: intent.intent, confidence: intent.confidence, source: 'approved-screen' });

    this.answerAbort?.abort();
    const abort = new AbortController();
    const abortFromCaller = (): void => abort.abort(input.signal.reason);
    input.signal.addEventListener('abort', abortFromCaller, { once: true });
    if (input.signal.aborted) abortFromCaller();
    this.answerAbort = abort;
    this.answerInterruptible = false;
    this.emit('answer:started', { questionId: record.id, captureId: input.captureId });
    this.emit('copilot:status', { status: 'answering', message: 'Analyzing screen' });

    try {
      telemetry.mark('retrievalStart');
      input.onTiming?.('rag-start');
      const compactContextPromise = Promise.resolve().then(() => this.contextBuilder.buildCompactScreenRequest(session, instruction, this.screenContext))
        .then((context) => {
          telemetry.mark('retrievalEnd');
          input.onTiming?.('rag-complete');
          return context;
        });
      const [optimizedImage, context] = await Promise.all([input.optimizedImage, compactContextPromise]);
      abort.signal.throwIfAborted();
      this.repositories.addEvent(session.id, 'CONTEXT_RETRIEVED', {
        source: 'approved-screen',
        chunks: context.resumeContext.length + context.jobContext.length + context.documentContext.length,
      });

      telemetry.mark('llmStart');
      let full = '';
      let screenContext: ScreenContext | undefined;
      let first = true;
      for await (const event of input.analyzer.streamAnalysis({
        image: optimizedImage.bytes,
        mimeType: optimizedImage.mimeType,
        sourceName: input.sourceName,
        capturedAt: input.capturedAt,
        question: instruction,
        context,
        preserveSmallText: optimizedImage.preserveSmallText,
        onProviderRequest: () => input.onTiming?.('gemini-request-start'),
        onFirstToken: () => input.onTiming?.('first-token'),
      }, abort.signal)) {
        abort.signal.throwIfAborted();
        if (event.type === 'context') { screenContext = event.context; continue; }
        if (first && event.text.trim()) { telemetry.mark('firstToken'); first = false; this.emit('copilot:status', { status: 'answering', message: 'Streaming screen answer' }); }
        full += event.text;
        this.emit('answer:token', { questionId: record.id, token: event.text });
      }
      input.onTiming?.('full-response-complete');
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error('Screen analysis was canceled.');
      if (!full.trim()) throw new Error('The screen provider completed without returning an answer. Please retry.');
      if (!screenContext) throw new Error('The screen provider did not return structured context. Please retry.');
      const resolvedQuestion = resolveScreenQuestion(screenContext, question);
      if (resolvedQuestion !== question) {
        question = resolvedQuestion;
        const resolvedIntent: QuestionIntent = { ...intent, question };
        this.repositories.updateQuestionText(record.id, question);
        this.repositories.updateTurnText(screenTurn.id, question);
        this.emit('question:resolved', { questionId: record.id, question: resolvedIntent });
      }
      this.setScreenContext(screenContext, session.id);
      const snapshot = telemetry.snapshot();
      const answer = this.repositories.addAnswer(session.id, record.id, full.trim(), input.analyzer.name, snapshot.totalQuestionToAnswerLatency);
      this.repositories.addTurn(session.id, 'copilot', full.trim(), undefined, record.id);
      this.repositories.addEvent(session.id, 'ANSWER_COMPLETED', { ...snapshot, source: 'approved-screen' });
      this.emit('answer:completed', { questionId: record.id, answer, telemetry: snapshot });
      this.emit('copilot:status', { status: 'ready', message: 'Answer ready' });
      return screenContext;
    } catch (error) {
      if (this.answerAbort === abort && !abort.signal.aborted) {
        this.emit('copilot:status', { status: 'recovering', message: 'Could not analyze the screen' });
      } else if (this.answerAbort === abort) {
        this.emit('copilot:status', { status: this.paused ? 'paused' : this.recognizer ? 'listening' : 'idle' });
      }
      throw error;
    } finally {
      input.signal.removeEventListener('abort', abortFromCaller);
      if (this.answerAbort === abort) { this.answerAbort = null; this.answerInterruptible = true; }
    }
  }

  clear(): void { this.answerAbort?.abort(); this.emit('copilot:status', { status: this.session ? 'listening' : 'idle' }); }

  private acceptFinalTranscript(event: TranscriptEvent): void {
    this.emit('transcript:final', event);
  }

  private interviewerTranscriptForDisplay(event: TranscriptEvent): TranscriptEvent {
    if (this.autoAnswerEnabled || event.sourceRole !== 'remote_interviewer' || !event.text.trim()) return event;
    const combined = mergeFinalTranscriptText(this.pendingInterviewerTranscript, event.text);
    if (event.isFinal) this.pendingInterviewerTranscript = combined;
    return { ...event, text: combined };
  }

  private async processQuestion(questionForModel: string, displayQuestion = questionForModel, force = false, alreadySaved = false, interruptible = true): Promise<boolean> {
    const perceivedStart = performance.now();
    // Pausing controls live audio/transcript processing only. A forced manual
    // question must remain usable while paused and during a Resume IPC race.
    if (!this.session || !this.interactionEnabled || (!force && this.paused) || (!displayQuestion.trim())) return false;
    if (!force && displayQuestion === this.lastQuestion) return false;
    this.lastQuestion = displayQuestion;
    if (!alreadySaved) this.repositories.addTurn(this.session.id, 'interviewer', displayQuestion, this.source ?? undefined);
    // Preserve the transcript while a user-requested screenshot is streaming,
    // but do not replace its answer with an automatic meeting question.
    if (!force && this.answerAbort && !this.answerInterruptible) return false;
    const telemetry = new Telemetry();
    telemetry.mark('questionStart'); telemetry.mark('intentStart');
    let intent = this.intentDetector.detect(displayQuestion);
    telemetry.mark('intentEnd');
    if (force && (!intent.isComplete || !intent.isAnswerNeeded)) intent = { ...intent, isComplete: true, isAnswerNeeded: true, intent: 'GENERAL_QUESTION', confidence: 1 };
    if (!intent.isComplete) { this.emit('copilot:status', { status: 'listening', message: 'Waiting for the rest of the question' }); return false; }
    if (!intent.isAnswerNeeded) { this.emit('copilot:status', { status: 'listening', message: 'No answer needed' }); return false; }
    if (questionForModel !== displayQuestion) intent = { ...intent, question: questionForModel };
    this.emit('question:detected', { ...intent, question: displayQuestion });
    this.emit('copilot:status', { status: 'question-detected', message: intent.intent.replaceAll('_', ' ').toLowerCase() });
    const record = this.repositories.addQuestion(this.session.id, { ...intent, question: displayQuestion });
    this.latestQuestionId = record.id;
    this.repositories.addEvent(this.session.id, 'QUESTION_DETECTED', { intent: intent.intent, confidence: intent.confidence });

    telemetry.mark('retrievalStart');
    this.emit('copilot:status', { status: 'retrieving', message: 'Finding relevant experience' });
    const context = this.contextBuilder.build(this.session, intent, this.screenContext);
    telemetry.mark('retrievalEnd');
    if (this.config.debugMode) console.debug('[answer-timing]', {
      milestone: 'context-ready', elapsedMs: Math.round(performance.now() - perceivedStart),
      conversationTurns: context.recentConversation.length,
      retrievedChunks: context.resumeContext.length + context.jobContext.length + context.documentContext.length,
      promptContextCharacters: context.recentConversation.reduce((sum, turn) => sum + turn.text.length, 0)
        + [...context.resumeContext, ...context.jobContext, ...context.documentContext].reduce((sum, chunk) => sum + chunk.text.length, 0),
    });
    this.repositories.addEvent(this.session.id, 'CONTEXT_RETRIEVED', { chunks: context.resumeContext.length + context.jobContext.length + context.documentContext.length });

    this.answerAbort?.abort();
    const abort = new AbortController();
    this.answerAbort = abort;
    this.answerInterruptible = interruptible;
    this.activeQuestionText = displayQuestion;
    this.emit('answer:started', { questionId: record.id });
    this.emit('copilot:status', { status: 'answering', message: 'Writing answer' });
    telemetry.mark('llmStart');
    let full = '';
    let first = true;
    try {
      for await (const token of this.model.streamAnswer(context, abort.signal)) {
        if (abort.signal.aborted) return false;
        if (first) {
          telemetry.mark('firstToken'); first = false;
          if (this.config.debugMode) console.debug('[answer-timing]', { milestone: 'first-token', elapsedMs: Math.round(performance.now() - perceivedStart) });
        }
        full += token;
        this.emit('answer:token', { questionId: record.id, token });
      }
      if (abort.signal.aborted) return false;
      if (!full.trim()) throw new Error('The answer provider completed without returning any text. Please retry the question.');
      const snapshot = telemetry.snapshot();
      if (this.config.debugMode) console.debug('[answer-timing]', { milestone: 'complete', elapsedMs: Math.round(performance.now() - perceivedStart) });
      const answer = this.repositories.addAnswer(this.session.id, record.id, full.trim(), this.model.name, snapshot.totalQuestionToAnswerLatency);
      this.repositories.addTurn(this.session.id, 'copilot', full.trim(), undefined, record.id);
      this.repositories.addEvent(this.session.id, 'ANSWER_COMPLETED', snapshot);
      this.emit('answer:completed', { questionId: record.id, answer, telemetry: snapshot });
      this.emit('copilot:status', { status: this.paused ? 'paused' : 'ready', message: this.paused ? 'Listening paused' : 'Answer ready' });
      return true;
    } catch (error) {
      if (abort.signal.aborted) return false;
      const message = error instanceof Error ? error.message : 'Answer generation failed.';
      this.emit('copilot:status', { status: this.paused ? 'paused' : 'recovering', message: 'Could not generate the answer' });
      this.emit('app:error', { title: 'Answer generation', message, recoverable: true });
      return false;
    } finally {
      if (this.answerAbort === abort) {
        this.answerAbort = null;
        this.answerInterruptible = true;
        this.activeQuestionText = '';
      }
    }
  }

  private beginCandidateSpeech(): void {
    if (this.candidatePendingQuestionId === undefined) this.candidatePendingQuestionId = this.latestQuestionId ?? null;
  }

  private persistCandidateFinal(text: string, confidence: number, source: AudioSourceDescriptor = CANDIDATE_SOURCE): void {
    const session = this.session;
    const normalized = text.trim();
    if (!session || !normalized) return;
    const questionId = this.candidatePendingQuestionId === undefined
      ? this.latestQuestionId ?? null
      : this.candidatePendingQuestionId;
    const canMerge = Boolean(this.candidateTurnId) && this.candidateTurnQuestionId === questionId;
    if (canMerge) {
      const merged = mergeFinalCandidateText(this.candidateTurnText, normalized);
      const updated = this.repositories.updateTurnText(this.candidateTurnId!, merged);
      if (updated) this.candidateTurnText = updated.text;
      else this.candidateTurnId = undefined;
    }
    if (!this.candidateTurnId || this.candidateTurnQuestionId !== questionId) {
      const turn = this.repositories.addTurn(session.id, 'candidate', normalized, source, questionId ?? undefined);
      this.candidateTurnId = turn.id;
      this.candidateTurnQuestionId = questionId;
      this.candidateTurnText = turn.text;
    }
    this.repositories.addEvent(session.id, 'CANDIDATE_TRANSCRIPT', {
      confidence, questionId, turnId: this.candidateTurnId,
    });
  }
}
