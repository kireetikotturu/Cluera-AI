import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerContext, AppEventMap, AppEventName, AudioSourceDescriptor, SessionInput, TranscriptEvent, TurnEvent } from '../src/shared/types';
import type { AppConfig } from '../src/main/config/appConfig';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import { ContextBuilder } from '../src/main/context/ContextBuilder';
import { IntentDetector } from '../src/main/interview/IntentDetector';
import { TurnGate } from '../src/main/interview/TurnGate';
import { InterviewOrchestrator } from '../src/main/interview/InterviewOrchestrator';
import type { AnswerModel } from '../src/main/llm/AnswerModel';
import type { SpeechRecognizer } from '../src/main/stt/SpeechRecognizer';

const runtime = path.join(process.cwd(), 'tests', '.runtime-live');
const input: SessionInput = { title: 'Live', role: 'Engineer', company: 'Acme', interviewType: 'mixed', language: 'English', answerStyle: 'Natural', answerLength: 'short', resumeText: 'Built React applications and secured APIs.', jobDescription: 'API engineer', instructions: '', selectedModel: 'mock', saveTranscript: true };
const interviewer: AudioSourceDescriptor = { id: 'system', kind: 'system', role: 'remote_interviewer', label: 'Interviewer', canTriggerAnswers: true };
const config = { databasePath: '', isProduction: false, demoMode: false, debugMode: false, deepgram: { apiKey: '', model: 'flux-general-en', language: 'en', eotThreshold: .75, maxReconnects: 2 }, gemini: { apiKey: '', model: 'gemini', timeoutMs: 1000 }, retrieval: { chunkSize: 850, chunkOverlap: 120, topK: 5 }, screen: { enabled: true, maxBytes: 5_000_000, maxDimension: 2560, model: 'gemini' }, licensing: { enforced: false, serverUrl: 'http://127.0.0.1:3000', publicKeyPem: '' } } as AppConfig;

class FakeRecognizer implements SpeechRecognizer {
  private partialCallback: (event: TranscriptEvent) => void = () => undefined;
  private finalCallback: (event: TranscriptEvent) => void = () => undefined;
  private turnCallback: (event: TurnEvent) => void = () => undefined;
  async start(): Promise<void> { /* connected */ }
  sendAudio(): void { /* audio is not needed */ }
  async stop(): Promise<void> { /* closed */ }
  onPartialTranscript(callback: (event: TranscriptEvent) => void): void { this.partialCallback = callback; }
  onFinalTranscript(callback: (event: TranscriptEvent) => void): void { this.finalCallback = callback; }
  onTurnEvent(callback: (event: TurnEvent) => void): void { this.turnCallback = callback; }
  onError(): void { /* not used */ }
  private transcript(text: string, isFinal: boolean): TranscriptEvent {
    return { text, isFinal, sourceId: interviewer.id, sourceKind: interviewer.kind, sourceRole: interviewer.role, canTriggerAnswers: true, confidence: 0.95, timestamp: Date.now() };
  }
  private turn(type: TurnEvent['type'], text: string): TurnEvent {
    return { type, transcript: text, sourceId: interviewer.id, sourceKind: interviewer.kind, sourceRole: interviewer.role, canTriggerAnswers: true, timestamp: Date.now() };
  }
  /** The interviewer starts a turn and the words so far arrive. */
  speak(text: string): void { this.turnCallback(this.turn('start', text)); this.partialCallback(this.transcript(text, false)); }
  /** More words of the same turn (the speech service repeats the whole turn so far). */
  more(text: string): void { this.partialCallback(this.transcript(text, false)); }
  /** The interviewer pauses long enough for the speech service to end the turn. */
  endTurn(text: string): void { this.finalCallback(this.transcript(text, true)); this.turnCallback(this.turn('end', text)); }
}

class CapturingModel implements AnswerModel {
  readonly name = 'Capturing model';
  readonly seen: AnswerContext[] = [];
  async *streamAnswer(context: AnswerContext): AsyncIterable<string> { this.seen.push(context); yield 'An answer.'; }
}

describe('live interview flow with Auto Answer', () => {
  let database: Database; let repositories: Repositories;
  beforeEach(async () => {
    fs.mkdirSync(runtime, { recursive: true });
    database = new Database(path.join(runtime, `${randomUUID()}.sqlite`)); await database.initialize(); repositories = new Repositories(database);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => { vi.useRealTimers(); database.close(); fs.rmSync(runtime, { recursive: true, force: true }); });

  async function setup(autoAnswer: boolean) {
    const model = new CapturingModel();
    const recognizer = new FakeRecognizer();
    const events: Array<{ name: AppEventName; payload: unknown }> = [];
    const emit = <K extends AppEventName>(name: K, payload: AppEventMap[K]): void => { events.push({ name, payload }); };
    const session = repositories.saveSession(input);
    const orchestrator = new InterviewOrchestrator(config, repositories, new IntentDetector(), new TurnGate(),
      new ContextBuilder(repositories, new LocalRetriever(repositories, config.retrieval)), model, emit, { recognizer: () => recognizer, stop: () => undefined });
    orchestrator.setAutoAnswerEnabled(autoAnswer);
    await orchestrator.start(session.id, interviewer);
    const questions = (): string[] => repositories.getDetail(session.id)!.questions.map((question) => question.text);
    const displayed = (): string[] => events.filter((event) => event.name === 'transcript:partial' || event.name === 'transcript:final').map((event) => (event.payload as TranscriptEvent).text);
    return { model, recognizer, orchestrator, session, questions, displayed };
  }

  it('answers a clear question quickly', async () => {
    const { recognizer, questions } = await setup(true);
    recognizer.speak('What is dependency injection?');
    recognizer.endTurn('What is dependency injection?');
    await vi.advanceTimersByTimeAsync(300);
    expect(questions()).toEqual([]);                    // a short moment to be sure the speaker has finished
    await vi.advanceTimersByTimeAsync(300);
    expect(questions()).toEqual(['What is dependency injection?']);
  });

  it('joins a scenario the interviewer pauses in and sends it to the AI as one question', async () => {
    const { recognizer, questions, model, displayed } = await setup(true);
    const situation = 'Imagine you have a payments service that handles a million requests a day.';
    recognizer.speak(situation);
    recognizer.endTurn(situation);
    await vi.advanceTimersByTimeAsync(1_800);           // the interviewer is thinking about how to put the question
    expect(questions()).toEqual([]);
    const rest = 'Sometimes it slows down at night. How would you find the cause?';
    recognizer.speak(rest);
    // While they talk, the screen shows the whole question, not just the new piece.
    expect(displayed().at(-1)).toBe(`${situation} ${rest}`);
    recognizer.endTurn(rest);
    await vi.advanceTimersByTimeAsync(700);
    expect(questions()).toEqual([`${situation} ${rest}`]);
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0].question).toContain('payments service');   // the AI sees the situation too
    expect(model.seen[0].question).toContain('How would you find the cause?');
  });

  it('does not answer while the interviewer is still talking', async () => {
    const { recognizer, questions } = await setup(true);
    recognizer.speak('Tell me about your experience with');
    recognizer.endTurn('Tell me about your experience with');
    await vi.advanceTimersByTimeAsync(1_500);
    recognizer.speak('Tell me');                         // they carry on
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual([]);
    recognizer.endTurn('microservices and message queues?');
    await vi.advanceTimersByTimeAsync(700);
    expect(questions()).toEqual(['Tell me about your experience with microservices and message queues?']);
  });

  it('never brings back what Clear removed when the same turn carries on', async () => {
    const { recognizer, orchestrator, questions, displayed } = await setup(true);
    recognizer.speak('Tell me');
    orchestrator.discardInput();                        // the customer presses Clear
    recognizer.more('Tell me about your experience with React and Node projects?');
    expect(displayed().at(-1)).toBe('about your experience with React and Node projects?');
    recognizer.endTurn('Tell me about your experience with React and Node projects?');
    await vi.advanceTimersByTimeAsync(700);
    expect(questions()).toEqual(['about your experience with React and Node projects?']);
  });

  it('sends nothing at all when the customer cleared everything and nothing new was said', async () => {
    const { recognizer, orchestrator, questions } = await setup(true);
    recognizer.speak('Tell me about your');
    orchestrator.discardInput();
    recognizer.endTurn('Tell me about your');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual([]);
  });

  it('drops a question that was still being collected when Clear is pressed', async () => {
    const { recognizer, orchestrator, questions } = await setup(true);
    const situation = 'Imagine you have a payments service that handles a million requests a day.';
    recognizer.speak(situation);
    recognizer.endTurn(situation);
    await vi.advanceTimersByTimeAsync(500);
    orchestrator.discardInput();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual([]);
    recognizer.speak('What is a closure?');             // the next thing said starts fresh
    recognizer.endTurn('What is a closure?');
    await vi.advanceTimersByTimeAsync(700);
    expect(questions()).toEqual(['What is a closure?']);
  });

  it('does not also send the collected question when the customer sends their own', async () => {
    const { recognizer, orchestrator, questions } = await setup(true);
    const situation = 'Imagine you have a payments service that handles a million requests a day.';
    recognizer.speak(situation);
    recognizer.endTurn(situation);
    await vi.advanceTimersByTimeAsync(500);
    await orchestrator.answer({ sessionId: (await Promise.resolve(repositories.listSessions()))[0].id, question: 'What is a closure?', origin: 'typed' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual(['What is a closure?']);
  });

  it('answers once when the customer presses Enter just before the speech service ends the sentence', async () => {
    const { recognizer, orchestrator, session, questions, model } = await setup(true);
    recognizer.speak('What is a monad');
    await orchestrator.answer({ sessionId: session.id, question: 'What is a monad', origin: 'transcript' });
    recognizer.endTurn('What is a monad?');             // the same words, now finished
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual(['What is a monad']);
    expect(model.seen).toHaveLength(1);
  });

  it('still answers when the interviewer carries on after the customer pressed Enter', async () => {
    const { recognizer, orchestrator, session, questions } = await setup(true);
    recognizer.speak('What is a monad');
    await orchestrator.answer({ sessionId: session.id, question: 'What is a monad', origin: 'transcript' });
    recognizer.endTurn('What is a monad in functional programming?');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toHaveLength(2);
    expect(questions()).toContain('What is a monad in functional programming?');
  });

  it('stops waiting when Auto Answer is switched off', async () => {
    const { recognizer, orchestrator, questions } = await setup(true);
    recognizer.speak('What is dependency injection?');
    recognizer.endTurn('What is dependency injection?');
    orchestrator.setAutoAnswerEnabled(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(questions()).toEqual([]);
  });
});

describe('live interview flow with Auto Answer off', () => {
  let database: Database; let repositories: Repositories;
  beforeEach(async () => {
    fs.mkdirSync(runtime, { recursive: true });
    database = new Database(path.join(runtime, `${randomUUID()}.sqlite`)); await database.initialize(); repositories = new Repositories(database);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => { vi.useRealTimers(); database.close(); fs.rmSync(runtime, { recursive: true, force: true }); });

  it('collects every spoken piece in the question box and sends nothing until the customer sends it', async () => {
    const model = new CapturingModel();
    const recognizer = new FakeRecognizer();
    const events: Array<{ name: AppEventName; payload: unknown }> = [];
    const emit = <K extends AppEventName>(name: K, payload: AppEventMap[K]): void => { events.push({ name, payload }); };
    const session = repositories.saveSession(input);
    const orchestrator = new InterviewOrchestrator(config, repositories, new IntentDetector(), new TurnGate(),
      new ContextBuilder(repositories, new LocalRetriever(repositories, config.retrieval)), model, emit, { recognizer: () => recognizer, stop: () => undefined });
    await orchestrator.start(session.id, interviewer);
    recognizer.speak('Can you explain');
    recognizer.endTurn('Can you explain');
    await vi.advanceTimersByTimeAsync(20_000);
    recognizer.speak('how dependency injection works?');
    recognizer.endTurn('how dependency injection works?');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(repositories.getDetail(session.id)!.questions).toHaveLength(0);
    const shown = events.filter((event) => event.name === 'transcript:final').map((event) => (event.payload as TranscriptEvent).text);
    expect(shown.at(-1)).toBe('Can you explain how dependency injection works?');
    // Sending (Alt+S or the Send button) answers the whole collected question once.
    expect(await orchestrator.answer({ sessionId: session.id, question: 'Can you explain how dependency injection works?', origin: 'transcript' })).toBe(true);
    expect(repositories.getDetail(session.id)!.questions).toHaveLength(1);
  });

  async function manualSetup() {
    const recognizer = new FakeRecognizer();
    const events: Array<{ name: AppEventName; payload: unknown }> = [];
    const emit = <K extends AppEventName>(name: K, payload: AppEventMap[K]): void => { events.push({ name, payload }); };
    const session = repositories.saveSession(input);
    const orchestrator = new InterviewOrchestrator(config, repositories, new IntentDetector(), new TurnGate(),
      new ContextBuilder(repositories, new LocalRetriever(repositories, config.retrieval)), new CapturingModel(), emit, { recognizer: () => recognizer, stop: () => undefined });
    await orchestrator.start(session.id, interviewer);
    const shown = (): string[] => events.filter((event) => event.name === 'transcript:partial' || event.name === 'transcript:final').map((event) => (event.payload as TranscriptEvent).text);
    return { recognizer, orchestrator, session, shown };
  }

  it('does not collect sent words again when the interviewer finishes the sentence after the customer sent it', async () => {
    const { recognizer, orchestrator, session, shown } = await manualSetup();
    recognizer.speak('How do promises work');
    await orchestrator.answer({ sessionId: session.id, question: 'How do promises work', origin: 'transcript' });
    expect(shown().at(-1)).toBe('');                    // the page is told that sentence is over
    const before = shown().length;
    recognizer.endTurn('How do promises work?');
    expect(shown()).toHaveLength(before);
    recognizer.speak('Tell me about the event loop?');
    expect(shown().at(-1)).toBe('Tell me about the event loop?');
  });

  it('shows what the interviewer adds after the customer sent, when the same sentence carries on', async () => {
    const { recognizer, orchestrator, session, shown } = await manualSetup();
    recognizer.speak('How do promises work');
    await orchestrator.answer({ sessionId: session.id, question: 'How do promises work', origin: 'transcript' });
    recognizer.more('How do promises work in the browser');
    expect(shown().at(-1)).toBe('in the browser');
  });

  it('leaves the interviewer\'s sentence alone when the customer sends something else meanwhile', async () => {
    const { recognizer, orchestrator, session, shown } = await manualSetup();
    recognizer.speak('Tell me about');
    await orchestrator.answer({ sessionId: session.id, question: 'What is REST?', origin: 'typed' });
    recognizer.more('Tell me about your last project');
    expect(shown().at(-1)).toBe('Tell me about your last project');
  });

  it('forgets cleared words in the question box too', async () => {
    const recognizer = new FakeRecognizer();
    const events: Array<{ name: AppEventName; payload: unknown }> = [];
    const emit = <K extends AppEventName>(name: K, payload: AppEventMap[K]): void => { events.push({ name, payload }); };
    const session = repositories.saveSession(input);
    const orchestrator = new InterviewOrchestrator(config, repositories, new IntentDetector(), new TurnGate(),
      new ContextBuilder(repositories, new LocalRetriever(repositories, config.retrieval)), new CapturingModel(), emit, { recognizer: () => recognizer, stop: () => undefined });
    await orchestrator.start(session.id, interviewer);
    recognizer.speak('Can you explain');
    recognizer.endTurn('Can you explain');
    orchestrator.discardInput();
    recognizer.speak('how dependency injection works?');
    const last = events.filter((event) => event.name === 'transcript:partial').map((event) => (event.payload as TranscriptEvent).text).at(-1);
    expect(last).toBe('how dependency injection works?');
  });
});
