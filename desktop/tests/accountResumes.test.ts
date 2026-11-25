import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountResumes } from '../src/main/accounts/AccountResumes';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { DocumentProcessor } from '../src/main/documents/DocumentProcessor';
import { FileLibraryService } from '../src/main/app/FileLibraryService';
import { SessionService } from '../src/main/app/SessionService';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import type { Session, SessionInput } from '../src/shared/types';

const owner = randomUUID();
const uploadUrl = (id: string) => `https://yhnqlfcgrmckhyjdxegg.supabase.co/storage/v1/object/upload/sign/customer-resumes/pending/${owner}/${id}?token=t`;
const account = { status: () => ({ state: 'active' as const, userId: owner }) as never, reportingCapability: async () => ({ accessToken: 'synthetic-access-token-000000', signal: new AbortController().signal }) };
const session = (overrides: Partial<Session> = {}): Session => ({ id: randomUUID(), title: 'Mock', company: 'Acme', role: 'Engineer', interviewType: 'mixed', language: 'English',
  answerStyle: 'Natural', answerLength: 'short', resumeText: 'Asha Rao\nSpring Boot developer', jobDescription: '', instructions: '', selectedModel: 'mock', createdAt: '', updatedAt: '', kind: 'interview', ...overrides }) as Session;
const pdf = Buffer.from('%PDF-1.4 synthetic resume bytes');
const library = (source: { name: string; extension: string; bytes: Buffer } | null) => ({ resumeSource: vi.fn(async () => source ? { ...source, hash: createHash('sha256').update(source.bytes).digest('hex') } : null) });
type Call = { url: string; init: RequestInit };
function server(replies: Array<() => Response>) {
  const calls: Call[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return (replies.shift() ?? (() => Response.json({ stored: true })))(); });
  return { calls, request: request as unknown as typeof fetch };
}
const body = (call: Call) => JSON.parse(String(call.init.body));

describe('saving a session résumé to the account', () => {
  it('sends the original PDF through a one-time upload address and then asks the server to keep it', async () => {
    const id = randomUUID(), s = session({ resumeFileName: 'Asha.pdf' });
    const api = server([() => Response.json({ id, stored: false, upload: { url: uploadUrl(id) } }), () => new Response('{}'), () => Response.json({ id, stored: true })]);
    const files = library({ name: 'Asha.pdf', extension: '.pdf', bytes: pdf });
    expect(await new AccountResumes(account, owner, files, api.request).save(s)).toBe('saved');
    expect(files.resumeSource).toHaveBeenCalledWith(s.resumeText, 'Asha.pdf');
    expect(api.calls.map((call) => [call.init.method, call.url])).toEqual([['POST', 'https://www.clueraai.in/api/account/resume'], ['PUT', uploadUrl(id)], ['POST', 'https://www.clueraai.in/api/account/resume']]);
    expect(body(api.calls[0])).toEqual({ step: 'BEGIN', kind: 'PDF', hash: createHash('sha256').update(pdf).digest('hex'), name: 'Asha.pdf', bytes: pdf.length, sessionRef: s.id, text: s.resumeText });
    expect(api.calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-access-token-000000' });
    expect(api.calls[1].init.headers).toEqual({ 'content-type': 'application/pdf', 'x-upsert': 'true' });
    expect(Buffer.from(api.calls[1].init.body as Uint8Array).equals(pdf)).toBe(true);
    expect(body(api.calls[2])).toEqual({ step: 'COMPLETE', id });
  });

  it('sends only the text when the file is gone, once per session and résumé', async () => {
    const api = server([() => Response.json({ id: randomUUID(), stored: true, upload: null })]);
    const resumes = new AccountResumes(account, owner, library(null), api.request), s = session({ resumeFileName: 'Resume on file' });
    expect(await resumes.save(s)).toBe('saved');
    expect(await resumes.save(s)).toBe('skipped');
    expect(api.calls).toHaveLength(1);
    expect(body(api.calls[0])).toMatchObject({ step: 'BEGIN', kind: 'TYPED', name: 'Typed résumé', text: s.resumeText });
  });

  it('never uploads a file anywhere but Cluera’s own résumé storage', async () => {
    for (const url of ['https://attacker.invalid/upload', 'https://yhnqlfcgrmckhyjdxegg.supabase.co/storage/v1/object/upload/sign/other-bucket/x']) {
      const api = server([() => Response.json({ id: randomUUID(), stored: false, upload: { url } })]);
      expect(await new AccountResumes(account, owner, library({ name: 'a.pdf', extension: '.pdf', bytes: pdf }), api.request).save(session())).toBe('failed');
      expect(api.calls).toHaveLength(1);
    }
  });

  it('tries again after a network problem but not after the account refuses', async () => {
    const flaky = server([() => new Response('', { status: 503 }), () => Response.json({ stored: true })]);
    expect(await new AccountResumes(account, owner, library(null), flaky.request, [1]).save(session())).toBe('saved');
    expect(flaky.calls).toHaveLength(2);
    const refused = server([() => new Response('', { status: 403 })]);
    expect(await new AccountResumes(account, owner, library(null), refused.request, [1, 1]).save(session())).toBe('failed');
    expect(refused.calls).toHaveLength(1);
    const signedOut = { ...account, status: () => ({ state: 'signed-out' }) as never };
    const none = server([]);
    expect(await new AccountResumes(signedOut, owner, library(null), none.request).save(session())).toBe('failed');
    expect(none.calls).toHaveLength(0);
  });

  it('does nothing for an assignment or a session without a résumé', async () => {
    const api = server([]);
    const resumes = new AccountResumes(account, owner, library(null), api.request);
    expect(await resumes.save(session({ kind: 'assignment' }))).toBe('skipped');
    expect(await resumes.save(session({ resumeText: '   ' }))).toBe('skipped');
    expect(api.calls).toHaveLength(0);
  });
});

describe('the original résumé file in Files', () => {
  let dir: string, db: Database, repositories: Repositories;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluera-resume-file-'));
    db = new Database(path.join(dir, 'test.sqlite')); await db.initialize();
    repositories = new Repositories(db);
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('is found by the session’s résumé text, unchanged, and saving a session reports it in the background', async () => {
    const original = path.join(dir, 'Asha CV.md');
    fs.writeFileSync(original, '# Asha Rao\r\nSpring Boot developer with Kafka experience.\r\n');
    const files = new FileLibraryService(repositories, new DocumentProcessor(), path.join(dir, 'library'));
    const uploaded = await files.upload('resume', original);
    const source = await files.resumeSource(`${uploaded.text}\n`, 'Asha CV.md');
    expect(source).toMatchObject({ name: 'Asha CV.md', extension: '.md' });
    expect(source!.bytes.equals(fs.readFileSync(original))).toBe(true);
    expect(await files.resumeSource('Someone else', 'Asha CV.md')).toBeNull();
    // A changed or removed copy is never sent as the original.
    fs.appendFileSync(path.join(dir, 'library', `${uploaded.libraryFileId}.md`), 'edited');
    expect(await files.resumeSource(uploaded.text, 'Asha CV.md')).toBeNull();

    const saved: Session[] = [];
    const sessions = new SessionService(repositories, new DocumentProcessor(), new LocalRetriever(repositories, { chunkSize: 850, chunkOverlap: 120, topK: 5 }), (value) => saved.push(value));
    const input: SessionInput = { title: 'Mock', company: 'Acme', role: 'Engineer', interviewType: 'mixed', language: 'English', answerStyle: 'Natural', answerLength: 'short', resumeText: uploaded.text, jobDescription: 'JD', instructions: '', selectedModel: 'mock' };
    const result = sessions.save(input);
    expect(saved).toEqual([result]);
    const broken = new SessionService(repositories, new DocumentProcessor(), new LocalRetriever(repositories, { chunkSize: 850, chunkOverlap: 120, topK: 5 }), () => { throw new Error('background'); });
    expect(() => broken.save(input)).not.toThrow();
  });
});
