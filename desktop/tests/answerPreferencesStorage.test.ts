import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { ContextBuilder } from '../src/main/context/ContextBuilder';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import { DEFAULT_ANSWER_PREFERENCES } from '../src/shared/answerPreferences';
import type { SessionInput } from '../src/shared/types';

const runtime = path.join(process.cwd(), 'tests', '.runtime-prefs');
const input: SessionInput = { title: 'Prefs', role: 'Engineer', company: 'Acme', interviewType: 'mixed', language: 'English', answerStyle: 'Natural', answerLength: 'short', jobDescription: 'API role', resumeText: 'Built APIs.', instructions: '', selectedModel: 'mock', saveTranscript: true };

describe('answer preferences storage', () => {
  let database: Database; let repositories: Repositories;
  beforeEach(async () => { fs.mkdirSync(runtime, { recursive: true }); database = new Database(path.join(runtime, `${randomUUID()}.sqlite`)); await database.initialize(); repositories = new Repositories(database); });
  afterEach(() => { database.close(); fs.rmSync(runtime, { recursive: true, force: true }); });

  it('stores the choice with the session and keeps it when the session is saved again without one', () => {
    const chosen = { fullScript: true, scriptWithBullets: false, bullets: true, fillerWords: false };
    const saved = repositories.saveSession({ ...input, answerPreferences: chosen });
    expect(repositories.getSession(saved.id)!.answerPreferences).toEqual(chosen);
    repositories.saveSession({ ...input, id: saved.id, title: 'Renamed' });
    expect(repositories.getSession(saved.id)!.answerPreferences).toEqual(chosen);
    repositories.saveSession({ ...input, id: saved.id, answerPreferences: { ...chosen, fullScript: false } });
    expect(repositories.getSession(saved.id)!.answerPreferences).toEqual({ ...chosen, fullScript: false });
  });
  it('gives sessions made before this setting the defaults', () => {
    const saved = repositories.saveSession(input);
    expect(repositories.getSession(saved.id)!.answerPreferences).toEqual(DEFAULT_ANSWER_PREFERENCES);
  });
  it('reaches the screenshot request context', () => {
    const chosen = { fullScript: false, scriptWithBullets: false, bullets: true, fillerWords: true };
    const saved = repositories.saveSession({ ...input, answerPreferences: chosen });
    const request = new ContextBuilder(repositories, new LocalRetriever(repositories, { chunkSize: 850, chunkOverlap: 120, topK: 5 })).buildCompactScreenRequest(saved, 'What is this?');
    expect(request.session.answerPreferences).toEqual(chosen);
  });
});
