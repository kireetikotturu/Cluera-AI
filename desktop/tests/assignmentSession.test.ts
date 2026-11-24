import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerContext, AppEventMap, AppEventName, AudioSourceDescriptor, Session, SessionInput, TranscriptEvent, TurnEvent } from '../src/shared/types';
import type { AppConfig } from '../src/main/config/appConfig';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import { ContextBuilder } from '../src/main/context/ContextBuilder';
import { IntentDetector } from '../src/main/interview/IntentDetector';
import { TurnGate } from '../src/main/interview/TurnGate';
import { InterviewOrchestrator } from '../src/main/interview/InterviewOrchestrator';
import { PromptBuilder } from '../src/main/llm/PromptBuilder';
import { ModelCatalog } from '../src/main/providers/ModelCatalog';
import type { AnswerModel } from '../src/main/llm/AnswerModel';
import type { SpeechRecognizer } from '../src/main/stt/SpeechRecognizer';
import { sessionInputSchema } from '../src/shared/schemas';
import {
  ASSIGNMENT_STYLE_DIRECT, ASSIGNMENT_STYLE_EXPLAINED, assignmentModeOf, BUILT_IN_SESSION_DEFAULTS, DEFAULT_ASSIGNMENT_CONTEXT, DEFAULT_ASSIGNMENT_MODEL, resolveSessionDefaults,
} from '../src/shared/sessionKinds';
import { DEFAULT_SESSION_CONTEXT } from '../src/shared/answerPreferences';

const runtime = path.join(process.cwd(), 'tests', '.runtime-assignment');
const assignment: SessionInput = { title: 'Java test', role: 'Assignment', company: 'Assignment', interviewType: 'mixed', language: 'English', answerStyle: ASSIGNMENT_STYLE_DIRECT, answerLength: 'medium', resumeText: '', jobDescription: '', instructions: 'MCQ and Java coding rounds.', selectedModel: 'mock', saveTranscript: true, autoAnswer: true, kind: 'assignment' };
const interview: SessionInput = { ...assignment, title: 'Interview', role: 'Engineer', company: 'Acme', kind: 'interview', autoAnswer: true, instructions: '', resumeText: 'Built APIs.' };
const speakers: AudioSourceDescriptor = { id: 'system', kind: 'system', role: 'remote_interviewer', label: 'Speakers', canTriggerAnswers: true };
const microphone: AudioSourceDescriptor = { id: 'candidate-microphone', kind: 'microphone', role: 'local_candidate', label: 'Microphone', canTriggerAnswers: false };
const config = { databasePath: '', isProduction: false, demoMode: false, debugMode: false, deepgram: { apiKey: '', model: 'flux-general-en', language: 'en', eotThreshold: .75, maxReconnects: 2 }, gemini: { apiKey: '', model: 'gemini', timeoutMs: 1000 }, retrieval: { chunkSize: 850, chunkOverlap: 120, topK: 5 }, screen: { enabled: true, maxBytes: 5_000_000, maxDimension: 2560, model: 'gemini' }, licensing: { enforced: false, serverUrl: 'http://127.0.0.1:3000', publicKeyPem: '' } } as AppConfig;

class FakeRecognizer implements SpeechRecognizer {
  private partialCallback: (event: TranscriptEvent) => void = () => undefined;
  private finalCallback: (event: TranscriptEvent) => void = () => undefined;
  private turnCallback: (event: TurnEvent) => void = () => undefined;
  constructor(private readonly source: AudioSourceDescriptor) {}
  async start(): Promise<void> { /* connected */ }
  sendAudio(): void { /* audio is not needed */ }
  async stop(): Promise<void> { /* closed */ }
  onPartialTranscript(callback: (event: TranscriptEvent) => void): void { this.partialCallback = callback; }
  onFinalTranscript(callback: (event: TranscriptEvent) => void): void { this.finalCallback = callback; }
  onTurnEvent(callback: (event: TurnEvent) => void): void { this.turnCallback = callback; }
  onError(): void { /* not used */ }
  private transcript(text: string, isFinal: boolean): TranscriptEvent {
    return { text, isFinal, sourceId: this.source.id, sourceKind: this.source.kind, sourceRole: this.source.role, canTriggerAnswers: this.source.canTriggerAnswers, confidence: 0.95, timestamp: Date.now() };
  }
  private turn(type: TurnEvent['type'], text: string): TurnEvent {
    return { type, transcript: text, sourceId: this.source.id, sourceKind: this.source.kind, sourceRole: this.source.role, canTriggerAnswers: this.source.canTriggerAnswers, timestamp: Date.now() };
  }
  speak(text: string): void { this.turnCallback(this.turn('start', text)); this.partialCallback(this.transcript(text, false)); }
  endTurn(text: string): void { this.finalCallback(this.transcript(text, true)); this.turnCallback(this.turn('end', text)); }
}

class CapturingModel implements AnswerModel {
  readonly name = 'Capturing model';
  readonly seen: AnswerContext[] = [];
  async *streamAnswer(context: AnswerContext): AsyncIterable<string> { this.seen.push(context); yield 'B) 42'; }
}

describe('assignment sessions', () => {
  let database: Database; let repositories: Repositories;
  beforeEach(async () => {
    fs.mkdirSync(runtime, { recursive: true });
    database = new Database(path.join(runtime, `${randomUUID()}.sqlite`)); await database.initialize(); repositories = new Repositories(database);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => { vi.useRealTimers(); database.close(); fs.rmSync(runtime, { recursive: true, force: true }); });

  async function setup(input: SessionInput) {
    const model = new CapturingModel();
    const byId = new Map<string, FakeRecognizer>();
    const events: Array<{ name: AppEventName; payload: unknown }> = [];
    const emit = <K extends AppEventName>(name: K, payload: AppEventMap[K]): void => { events.push({ name, payload }); };
    const session = repositories.saveSession(input);
    const orchestrator = new InterviewOrchestrator(config, repositories, new IntentDetector(), new TurnGate(),
      new ContextBuilder(repositories, new LocalRetriever(repositories, config.retrieval)), model, emit,
      { recognizer: (source) => { const fake = new FakeRecognizer(source); byId.set(source.id, fake); return fake; }, stop: () => undefined });
    orchestrator.setAutoAnswerEnabled(true);
    await orchestrator.start(session.id, speakers);
    // The microphone recognizer is created when the first microphone audio arrives.
    orchestrator.sendAudio('candidate', Buffer.alloc(2_560));
    const questions = (): string[] => repositories.getDetail(session.id)!.questions.map((question) => question.text);
    const shown = (): TranscriptEvent[] => events.filter((event) => event.name === 'transcript:partial' || event.name === 'transcript:final').map((event) => event.payload as TranscriptEvent);
    return { model, session, orchestrator, questions, shown, speakers: byId.get('system')!, mic: byId.get('candidate-microphone')! };
  }

  it('keeps the session kind and defaults every older session to an interview', () => {
    const saved = repositories.saveSession(assignment);
    expect(repositories.getSession(saved.id)!.kind).toBe('assignment');
    expect(repositories.saveSession({ ...assignment, id: saved.id, title: 'Renamed', kind: undefined }).kind).toBe('assignment');
    const { kind: _kind, ...withoutKind } = interview;
    expect(repositories.getSession(repositories.saveSession(withoutKind).id)!.kind).toBe('interview');
    expect(sessionInputSchema.safeParse({ ...assignment, kind: 'exam' }).success).toBe(false);
  });

  it('turns the answer style into one of two modes', () => {
    expect(assignmentModeOf(ASSIGNMENT_STYLE_DIRECT)).toBe('direct');
    expect(assignmentModeOf(ASSIGNMENT_STYLE_EXPLAINED)).toBe('explained');
    // A new assignment starts with explanations; only a session saved with the direct style answers directly.
    expect(assignmentModeOf('Natural and confident')).toBe('explained');
    expect(assignmentModeOf(undefined)).toBe('explained');
  });

  it('asks the AI for a direct answer or an explained one, as chosen, without any interview wording', () => {
    const build = (answerStyle: string, session: Partial<Session> = {}): string => new PromptBuilder().build({
      question: 'Which of these is a prime number? A 4 B 9 C 7 D 8', intent: 'GENERAL_QUESTION', recentConversation: [], resumeContext: [], jobContext: [], documentContext: [],
      instructions: 'MCQ and Java coding rounds.', session: { id: '1', title: 'T', role: 'Assignment', company: 'Assignment', interviewType: 'mixed', language: 'English', answerStyle, answerLength: 'medium', jobDescription: '', resumeText: '', instructions: 'MCQ and Java coding rounds.', selectedModel: 'm', kind: 'assignment', createdAt: '', updatedAt: '', ...session },
    });
    const direct = build(ASSIGNMENT_STYLE_DIRECT);
    expect(direct).toContain('direct answer only');
    expect(direct).toContain('MCQ and Java coding rounds.');
    expect(direct).toContain('Which of these is a prime number');
    expect(direct).not.toMatch(/interview|candidate|resume/i);
    const explained = build(ASSIGNMENT_STYLE_EXPLAINED);
    expect(explained).toContain('answer with explanation');
    expect(explained).not.toContain('direct answer only');
    expect(build(ASSIGNMENT_STYLE_DIRECT, { language: 'Telugu' })).toContain('Answer language: Telugu');
  });

  it('answers a spoken question from the speakers', async () => {
    const { speakers: spk, questions, model } = await setup(assignment);
    spk.speak('Which of these is a prime number A 4 B 9 C 7 D 8?');
    spk.endTurn('Which of these is a prime number A 4 B 9 C 7 D 8?');
    await vi.advanceTimersByTimeAsync(700);
    expect(questions()).toHaveLength(1);
    expect(model.seen[0].session.kind).toBe('assignment');
  });

  it('also takes a question spoken into the microphone, and shows it where the question goes', async () => {
    const { mic, questions, shown } = await setup(assignment);
    mic.speak('Write a Java program to reverse a string');
    expect(shown().at(-1)).toMatchObject({ text: 'Write a Java program to reverse a string', sourceRole: 'remote_interviewer', canTriggerAnswers: true });
    mic.endTurn('Write a Java program to reverse a string');
    await vi.advanceTimersByTimeAsync(1_200);
    expect(questions()).toEqual(['Write a Java program to reverse a string']);
  });

  it('answers a task that is not worded as a question', async () => {
    const { mic, questions } = await setup(assignment);
    mic.speak('Find the output of the following code');
    mic.endTurn('Find the output of the following code');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(questions()).toEqual(['Find the output of the following code']);
  });

  it('ignores the microphone while it is only hearing the speakers', async () => {
    const { speakers: spk, mic, questions } = await setup(assignment);
    spk.speak('What is the time complexity of binary search?');
    mic.speak('What is the time complexity of binary search?');   // the same words, heard through the air
    mic.endTurn('What is the time complexity of binary search?');
    spk.endTurn('What is the time complexity of binary search?');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(questions()).toEqual(['What is the time complexity of binary search?']);
  });

  it('keeps the microphone as the customer\'s own voice in an interview session', async () => {
    const { mic, questions, shown } = await setup(interview);
    mic.speak('Write a Java program to reverse a string');
    mic.endTurn('Write a Java program to reverse a string');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(questions()).toEqual([]);
    expect(shown().every((event) => event.sourceRole === 'local_candidate')).toBe(true);
  });
});

describe('session defaults from the Admin', () => {
  it('falls back to the built-in text and model for anything missing, blank or odd', () => {
    expect(resolveSessionDefaults(undefined)).toEqual(BUILT_IN_SESSION_DEFAULTS);
    expect(resolveSessionDefaults({ interviewContext: '  ', assignmentContext: 5, assignmentModel: 'bad model!' })).toEqual(BUILT_IN_SESSION_DEFAULTS);
    expect(resolveSessionDefaults({ interviewContext: 'Be brief.', assignmentContext: 'Java only.', assignmentModel: 'claude-haiku-5-5' }))
      .toEqual({ interviewContext: 'Be brief.', assignmentContext: 'Java only.', assignmentModel: 'claude-haiku-5-5' });
    expect(resolveSessionDefaults({ interviewContext: 'x'.repeat(4_001) }).interviewContext).toBe(DEFAULT_SESSION_CONTEXT);
    expect(DEFAULT_ASSIGNMENT_MODEL).toBe('gpt-6-luna');
    expect(DEFAULT_ASSIGNMENT_CONTEXT).toMatch(/MCQ and coding in Java, SQL and Python/);
  });

  it('are passed from the model list response to the app, and the built-in ones apply until the server answers', async () => {
    const answer = { models: [{ provider: 'gemini', modelId: 'g-1', displayName: 'Gemini One', description: 'Google Gemini model', enabled: true, isDefault: true }],
      sessionDefaults: { interviewContext: 'Short answers.', assignmentContext: 'SQL round only.', assignmentModel: 'gpt-6-luna' } };
    const catalog = new ModelCatalog('https://example.test', { gemini: 'g-1', deepgram: 'flux-general-en' },
      (async () => new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof fetch, false, () => false, '/api/account/models');
    expect(catalog.sessionDefaults()).toEqual(BUILT_IN_SESSION_DEFAULTS);
    await catalog.refresh(true);
    expect(catalog.sessionDefaults()).toEqual(answer.sessionDefaults);
  });

  it('are the same text on the website and in the app', () => {
    const web = fs.readFileSync('../web/lib/accounts/sessionDefaults.ts', 'utf8');
    expect(web).toContain(DEFAULT_SESSION_CONTEXT);
    expect(web).toContain(DEFAULT_ASSIGNMENT_CONTEXT);
    expect(web).toContain(`assignmentModel:'${DEFAULT_ASSIGNMENT_MODEL}'`);
  });
});

describe('assignment wiring', () => {
  const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const ipc = read('src/main/ipc/registerIpc.ts');
  const page = read('src/renderer/pages/CopilotPage.tsx');
  const editor = read('src/renderer/pages/SessionEditorPage.tsx');

  it('only lets clicks pass through while Alt+M can bring them back', () => {
    // Alt+M is registered first and the mode is refused when it cannot be, so the customer is never locked out.
    expect(ipc).toContain("if (!register('Alt+M', () => setTouchThrough(!touchThrough))) return false;");
    expect(ipc).toContain('window.setIgnoreMouseEvents(enabled, { forward: true })');
    expect(ipc).toContain("window.webContents.on?.('render-process-gone', releaseAssignmentMode)");
    expect(ipc).toContain("if (event.sender !== window.webContents) throw new Error('Unauthorized window request.')");
    expect(page).toContain('const assignmentActive = isAssignment && running && !collapsed;');
  });

  it('shows the Interview and Assignment switch, with Auto Answer on and no tick box for assignments', () => {
    expect(editor).toContain('aria-label="Session type"');
    expect(editor).toContain("onClick={() => chooseKind('assignment')}");
    expect(editor).toContain('Simple, direct answer only');
    expect(editor).toContain('Answer with explanation');
    expect(editor).toContain('autoAnswer: true,');
    expect(editor).toContain('{!isAssignment && <label><input type="checkbox" checked={form.autoAnswer ?? false}');
    expect(editor).toContain('autoAnswer: false, saveTranscript: true');
  });

  it('keeps the click-through window dependable: never takes the keyboard, restores itself and says when it cannot work', () => {
    // Hearing a question must not pull the keyboard away from the page being worked on.
    expect(ipc).toContain('if (assignmentModeActive) return false;');
    // A lost live window mode is restored instead of silently refusing, and the ignore-mouse state is put back.
    expect(ipc).toContain('if (!sessionModeActive) setSessionMode(true);');
    expect(ipc).toContain('const reassertTouchThrough = (): void => {');
    expect(ipc).toContain("globalShortcut.isRegistered?.(key)");
    // Anything that ends the live work tells the page, so it never shows "Touch off" for a window that is already normal.
    expect(read('src/main/main.ts')).toContain("emit('session:interrupted', null); accountProviders?.stop();");
    // The page tries again a few times and then shows the truth.
    expect(page).toContain('const retryAfter = [500, 1_500, 3_500];');
    expect(page).toContain("touchUnavailable ? 'Alt+M unavailable'");
    expect(page).toContain('Hands-free after Start · Alt+M');
  });

  it('starts a new assignment with "Answer with explanation" selected', () => {
    expect(editor).toContain("checked={assignmentMode === 'explained'}");
    expect(editor).toContain('const assignmentMode = assignmentModeOf(form.answerStyle);');
    expect(assignmentModeOf('Natural and confident')).toBe('explained');
  });
});

