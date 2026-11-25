import { describe, expect, it, vi } from 'vitest';
import { AccountPhoneSessions } from '../src/main/accounts/AccountPhoneSessions';

const owner = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const summary = { id: sessionId, kind: 'interview', title: 'Java developer · Acme', role: 'Java developer', company: 'Acme', model: 'gemini-3.5-flash',
  startedAt: '2026-11-25T10:00:00+00:00', endedAt: null, updatedAt: '2026-11-25T10:05:00+00:00', questionCount: 1 };
const detail = { ...summary, questionCount: undefined, setup: { language: 'English' },
  turns: [{ id: 'q1', question: 'What is polymorphism?', answer: 'One interface, many forms.', at: '2026-11-25T10:01:00+00:00', source: 'voice' }] };
delete (detail as Record<string, unknown>).questionCount;

const account = (state: 'active' | 'signed-out' = 'active', userId = owner) => ({
  status: () => ({ mode: 'cluera-staging' as const, state, userId }),
  reportingCapability: vi.fn(async () => ({ accessToken: 'synthetic-access-token-0000', signal: new AbortController().signal })),
});
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('phone sessions in the Windows app', () => {
  it('lists the sessions with the signed-in account, never sending credentials in the address or cookies', async () => {
    const request = respond({ code: 'ACTIVE', sessions: [summary] });
    const sessions = await new AccountPhoneSessions(account(), owner, request).list();
    expect(sessions).toHaveLength(1);
    const [url, init] = vi.mocked(request).mock.calls[0];
    expect(String(url)).toBe('https://www.clueraai.in/api/account/native/phone-sessions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', body: '{"action":"LIST"}' });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-access-token-0000');
  });

  it('reads one session and refuses an answer that is for a different session', async () => {
    const reader = new AccountPhoneSessions(account(), owner, respond({ code: 'ACTIVE', session: detail }));
    expect((await reader.read(sessionId)).turns[0].answer).toBe('One interface, many forms.');
    const other = '00000000-0000-4000-8000-0000000000bb';
    await expect(new AccountPhoneSessions(account(), owner, respond({ code: 'ACTIVE', session: detail })).read(other)).rejects.toThrow();
    await expect(reader.read('not-an-id')).rejects.toThrow();
  });

  it('does nothing when the account is signed out or belongs to someone else, and sends nothing', async () => {
    const request = respond({ code: 'ACTIVE', sessions: [] });
    await expect(new AccountPhoneSessions(account('signed-out'), owner, request).list()).rejects.toThrow('unavailable');
    await expect(new AccountPhoneSessions(account('active', '00000000-0000-4000-8000-0000000000cc'), owner, request).list()).rejects.toThrow('unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('turns a refused request or an unexpected answer into one plain message', async () => {
    await expect(new AccountPhoneSessions(account(), owner, respond({ error: 'x' }, 503)).list()).rejects.toThrow('unavailable');
    await expect(new AccountPhoneSessions(account(), owner, respond({ code: 'ACTIVE', sessions: [{ ...summary, extra: 1 }] })).list()).rejects.toThrow();
  });
});
