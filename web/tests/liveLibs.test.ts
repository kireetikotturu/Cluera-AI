import { describe, expect, it } from 'vitest';
import { CHUNK_SAMPLES, downsample, PcmChunker } from '../lib/live/pcm';
import { inlineParts, parseAnswerBlocks } from '../lib/live/answerBlocks';
import { fitWithin } from '../lib/live/photo';
import { buildAnswerContext, chunkText, DocumentIndex, indexSetup } from '../lib/live/context';
import { photoPrompt, questionPrompt } from '../lib/live/prompt';
import { historyPayload } from '../lib/live/liveApi';
import { parseIncoming } from '../lib/live/relayLink';
import { IntentDetector } from '../../desktop/src/main/interview/IntentDetector';
import { DEFAULT_ANSWER_PREFERENCES } from '../../desktop/src/shared/answerPreferences';
import type { LiveSetup, LiveSnapshot, LiveTurn } from '../lib/live/types';

const setup = (extra: Partial<LiveSetup> = {}): LiveSetup => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'interview', title: '', role: 'Java developer', company: 'Acme', interviewType: 'mixed', language: 'English',
  answerLength: 'medium', answerStyle: 'Natural and confident', answerPreferences: DEFAULT_ANSWER_PREFERENCES, instructions: 'Keep it short.',
  resumeText: 'Ravi Kumar\nBackend engineer.\n\nBuilt payment services in Java and Spring Boot at Globex. Led a team of four.\n\nEducation: B.Tech in Computer Science, 2021.',
  jobDescription: 'We need a backend engineer who knows Java microservices and Kafka.', supporting: [{ name: 'Notes', text: 'I prefer simple, direct examples.' }],
  documentNames: ['CV'], modelId: 'gemini-3.5-flash', modelReadsImages: true, autoAnswer: true, saveHistory: true, ...extra,
});
const intent = (text: string) => new IntentDetector().detect(text);

describe('phone sound', () => {
  it('turns 48 kHz sound into 16 kHz whole-number samples within range', () => {
    const input = new Float32Array(4800).map((_, index) => Math.sin(index / 20));
    const output = downsample(input, 48_000);
    expect(output).toHaveLength(1600);
    expect(Math.max(...output)).toBeLessThanOrEqual(32767);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(-32768);
    expect(downsample(new Float32Array([2, -2, 0]), 16_000)).toEqual(Int16Array.from([32767, -32768, 0]));
  });
  it('collects small pieces into whole 80 ms chunks and keeps the remainder', () => {
    const chunker = new PcmChunker();
    expect(chunker.push(new Int16Array(1000))).toHaveLength(0);
    const chunks = chunker.push(new Int16Array(1600));
    expect(chunks).toHaveLength(2);
    expect(chunks.every(chunk => chunk.length === CHUNK_SAMPLES)).toBe(true);
    expect(chunker.push(new Int16Array(CHUNK_SAMPLES)).length).toBe(1);
    chunker.reset();
    expect(chunker.push(new Int16Array(10))).toHaveLength(0);
  });
});

describe('the answer text', () => {
  it('reads paragraphs, bullets, headings and code fences', () => {
    const blocks = parseAnswerBlocks('Polymorphism lets **one interface** take many forms.\n\n- First\n- Second\n\n1. One\n2. Two\n\n### Code\n```java\nclass A {}\n```\nDone.');
    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'list', 'list', 'heading', 'code', 'paragraph']);
    expect(blocks[1]).toMatchObject({ ordered: false, items: ['First', 'Second'] });
    expect(blocks[2]).toMatchObject({ ordered: true });
    expect(blocks[4]).toMatchObject({ language: 'java', text: 'class A {}' });
  });
  it('shows a code fence that is still being written, and splits bold and code in a line', () => {
    expect(parseAnswerBlocks('```sql\nselect 1')).toEqual([{ type: 'code', language: 'sql', text: 'select 1' }]);
    expect(inlineParts('Use **final** and `static` here')).toEqual([{ kind: 'text', text: 'Use ' }, { kind: 'bold', text: 'final' }, { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'static' }, { kind: 'text', text: ' here' }]);
  });
});

describe('photos', () => {
  it('fits a large photo inside the limit without ever making a small one bigger', () => {
    expect(fitWithin(4032, 3024, 1800)).toEqual({ width: 1800, height: 1350 });
    expect(fitWithin(3024, 4032, 1800)).toEqual({ width: 1350, height: 1800 });
    expect(fitWithin(800, 600, 1800)).toEqual({ width: 800, height: 600 });
  });
});

describe('what the AI is told', () => {
  it('searches the résumé like the Windows app and gives a personal question the whole résumé', () => {
    const index = indexSetup(setup());
    const personal = questionPrompt(buildAnswerContext(setup(), index, intent('Tell me about yourself and your projects?'), []));
    expect(personal).toContain('Ravi Kumar');
    expect(personal).toContain('Built payment services in Java');
    expect(personal).toContain('Target role: Java developer');
    expect(personal).toContain('Custom instructions: Keep it short.');
    const technical = questionPrompt(buildAnswerContext(setup(), index, intent('What is Kafka used for in microservices?'), []));
    expect(technical).toContain('Kafka');
    expect(technical).toContain('CURRENT QUESTION');
  });
  it('carries the earlier questions and answers of the session into the next prompt', () => {
    const turns: LiveTurn[] = [{ id: 'a', question: 'What is a thread?', answer: 'A unit of execution.', at: '2026-11-25T10:00:00Z', source: 'voice', state: 'done' }];
    const prompt = questionPrompt(buildAnswerContext(setup(), indexSetup(setup()), intent('And how is it different from a process?'), turns));
    expect(prompt).toContain('INTERVIEWER: What is a thread?');
    expect(prompt).toContain('PREVIOUS AI SUGGESTION: A unit of execution.');
  });
  it('writes the assignment rules for a test and the photo rules for a photo', () => {
    const test = setup({ kind: 'assignment', answerStyle: 'Direct answer only', instructions: 'MCQ in Java and SQL.' });
    const prompt = questionPrompt(buildAnswerContext(test, indexSetup(test), intent('Find the output of this code: print(2+3)'), []));
    expect(prompt).toContain('assignment or online test');
    expect(prompt).toContain('direct answer only');
    const photo = photoPrompt(buildAnswerContext(test, indexSetup(test), { ...intent('x'), question: 'Answer the question shown in the photo', isAnswerNeeded: true }, []), '');
    expect(photo).toContain('photo');
    expect(photo).toContain('Answer the question shown in the photo');
    const interview = photoPrompt(buildAnswerContext(setup(), indexSetup(setup()), { ...intent('x'), question: 'Q' }, []), 'question 3 only');
    expect(interview).toContain('Current task: question 3 only');
    expect(interview).toContain('Ravi Kumar');
  });
  it('cuts long text into pieces and indexes only documents that have text', () => {
    expect(chunkText('a'.repeat(2000)).length).toBeGreaterThan(2);
    expect(chunkText('First paragraph.\n\nSecond paragraph.')).toEqual(['First paragraph.\n\nSecond paragraph.']);
    const index = new DocumentIndex('s', [{ type: 'resume', name: 'CV', text: 'Java developer at Globex' }]);
    expect(index.search('java').matched('resume')).toHaveLength(1);
    expect(index.search('java').matched('supporting')).toHaveLength(0);
    expect(index.search('java').leading('resume', 1)).toHaveLength(1);
  });
});

describe('history and relay messages', () => {
  const snapshot = (turns: LiveTurn[]): LiveSnapshot => ({ status: 'listening', message: '', paused: false, autoAnswer: true, heard: '', collected: '', turns,
    activeTurnId: null, startedAt: Date.parse('2026-11-25T10:00:00Z'), modelId: 'gemini-3.5-flash', answerLength: 'medium', questionSequence: 1 });
  it('saves finished answers and the settings, never the résumé text or a photo', () => {
    const turns: LiveTurn[] = [
      { id: 'a', question: 'Q1', answer: 'A1', at: 'x', source: 'voice', state: 'done', model: 'm' },
      { id: 'b', question: 'Q2', answer: 'partial', at: 'x', source: 'typed', state: 'cancelled' },
      { id: 'c', question: 'Q3', answer: 'still going', at: 'x', source: 'photo', state: 'writing', photo: 'data:image/jpeg;base64,AAAA' },
      { id: 'd', question: 'Q4', answer: '', at: 'x', source: 'voice', state: 'failed' },
    ];
    const payload = historyPayload(setup(), snapshot(turns), null) as Record<string, any>;
    expect(payload.turns.map((turn: { id: string }) => turn.id)).toEqual(['a', 'b']);
    expect(payload.title).toBe('Java developer · Acme');
    expect(JSON.stringify(payload)).not.toContain('Ravi Kumar');
    expect(JSON.stringify(payload)).not.toContain('base64');
    expect(payload.endedAt).toBeNull();
    expect(payload.startedAt).toBe('2026-11-25T10:00:00.000Z');
  });
  it('trims the oldest questions when a very long session would not fit', () => {
    const turns: LiveTurn[] = Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, question: 'Q', answer: 'x'.repeat(20_000), at: 'x', source: 'voice' as const, state: 'done' as const }));
    const payload = historyPayload(setup(), snapshot(turns), '2026-11-25T11:00:00Z') as { turns: Array<{ id: string }> };
    expect(JSON.stringify(payload.turns).length).toBeLessThanOrEqual(440_000);
    expect(payload.turns.at(-1)?.id).toBe('t39');
  });
  it('accepts exactly the relay messages it knows and rejects everything else', () => {
    expect(parseIncoming('{"type":"ready","protocol":1}')).toEqual({ type: 'ready' });
    expect(parseIncoming('{"type":"audioReady","channel":"interviewer"}')).toEqual({ type: 'audioReady', channel: 'interviewer' });
    expect(parseIncoming('{"type":"answer","id":"q1","text":"Hi"}')).toEqual({ type: 'answer', id: 'q1', text: 'Hi' });
    expect(parseIncoming('{"type":"transcript","channel":"interviewer","event":"EndOfTurn","transcript":"Hello"}')).toMatchObject({ event: 'EndOfTurn' });
    for (const bad of ['not json', '{"type":"mystery"}', '{"type":"answer","id":"bad id!","text":"x"}', '{"type":"audioReady","channel":"other"}',
      '{"type":"transcript","channel":"interviewer","event":"Nope","transcript":"x"}', '[]', 'null']) expect(parseIncoming(bad)).toBeNull();
    expect(parseIncoming(new ArrayBuffer(4))).toBeNull();
  });
});
