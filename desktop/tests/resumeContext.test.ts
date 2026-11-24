import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { SessionService } from '../src/main/app/SessionService';
import { DocumentProcessor } from '../src/main/documents/DocumentProcessor';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import { ContextBuilder } from '../src/main/context/ContextBuilder';
import { IntentDetector } from '../src/main/interview/IntentDetector';
import { PromptBuilder } from '../src/main/llm/PromptBuilder';
import type { SessionInput } from '../src/shared/types';

const resume = `Kireeti Kotturu
Full Stack Developer | kireeti@example.com | Hyderabad

SUMMARY
Final year engineering student who builds web products with React, Node and PostgreSQL.

SKILLS
React, TypeScript, Node.js, PostgreSQL, Docker, AWS

PROJECTS
Cluera AI - Windows interview copilot built with Electron, live transcription and a retrieval pipeline.
Sigma Round - Interview practice platform with coding rounds and scorecards.
Campus Pay - Payments dashboard with Razorpay checkout and refunds.

EDUCATION
B.Tech in Computer Science, 2025`;
const filler = Array.from({ length: 30 }, (_, i) => `Section ${i}\n${'Detailed work history line about databases, cloud pipelines and testing practice. '.repeat(8)}`).join('\n\n');
const input: SessionInput = {
  title: 'Mock', company: 'Acme', role: 'Software Engineer', interviewType: 'mixed', language: 'English', answerStyle: 'Natural', answerLength: 'short',
  resumeText: `${resume}\n\n${filler}`, jobDescription: 'We need an engineer who knows React and cloud.', instructions: '', selectedModel: 'mock', saveTranscript: true,
};
const detector = new IntentDetector();

describe('resume reaches the answer prompt', () => {
  let dir: string, db: Database, repo: Repositories, service: SessionService, retriever: LocalRetriever;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluera-resume-'));
    db = new Database(path.join(dir, 'test.sqlite')); await db.initialize();
    repo = new Repositories(db);
    retriever = new LocalRetriever(repo, { chunkSize: 850, chunkOverlap: 120, topK: 5 });
    service = new SessionService(repo, new DocumentProcessor(), retriever);
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const prompt = (question: string, force = true) => {
    const session = service.save(input);
    const detected = detector.detect(question);
    const intent = force && (!detected.isComplete || !detected.isAnswerNeeded) ? { ...detected, isComplete: true, isAnswerNeeded: true, intent: 'GENERAL_QUESTION' as const } : detected;
    return new PromptBuilder().build(new ContextBuilder(repo, retriever).build(session, intent));
  };

  it.each([
    'Introduce yourself',
    'Can you introduce yourself?',
    'Tell me about yourself.',
    'What is your name?',
    'Who are you?',
  ])('includes the candidate name and summary for "%s"', (question) => {
    const text = prompt(question);
    expect(text).toContain('Kireeti Kotturu');
    expect(text).toContain('Full Stack Developer');
  });

  it.each([
    'What are your favorite projects?',
    'Which projects have you worked on?',
    'Tell me about your best project.',
    'Walk me through the projects on your resume.',
  ])('includes the projects section for "%s"', (question) => {
    const text = prompt(question);
    expect(text).toContain('Cluera AI');
    expect(text).toContain('Campus Pay');
  });

  it('still includes the candidate name for an unrelated technical question', () => {
    expect(prompt('How does a database index work?')).toContain('Kireeti Kotturu');
  });

  it('uses the typed supporting context for personal questions even without keyword overlap', () => {
    const session = service.save(input);
    service.addText(session.id, 'supporting', 'Typed context', 'My favourite thing to build is offline-first mobile apps.');
    const intent = detector.detect('Tell me about your background.');
    const text = new PromptBuilder().build(new ContextBuilder(repo, retriever).build(session, intent));
    expect(text).toContain('offline-first mobile apps');
  });

  it('matches plural and singular wording between the question and the resume', () => {
    const session = service.save({ ...input, resumeText: 'Priya Rao\nI shipped a Project called Atlas for logistics.' });
    expect(retriever.retrieve(session.id, 'projects').some((chunk) => chunk.text.includes('Atlas'))).toBe(true);
  });
});
