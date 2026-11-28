import type { AccessGrant, LiveSetup, LiveSnapshot, LiveTurn } from './types';
import type { UnlimitedAccess } from '../../../desktop/src/shared/accountCredits';

export type ApiFailure = 'signin' | 'rate' | 'unavailable' | 'invalid';
export class LiveApiError extends Error {
  constructor(readonly kind: ApiFailure) {
    super(kind === 'signin' ? 'Your sign-in has ended. Open My account and sign in again.'
      : kind === 'rate' ? 'Too many requests. Wait a minute and try again.'
      : kind === 'invalid' ? 'That request was not accepted.' : 'Cluera is not reachable right now. Check your internet and try again.');
  }
}

export interface ModelOption { modelId: string; displayName: string; provider: 'gemini' | 'openai' | 'anthropic'; isDefault: boolean; tag: string; image: boolean }
export interface SessionDefaults { interviewContext: string; assignmentContext: string; assignmentModel: string }
export type DocumentKind = 'RESUME' | 'JOB_DESCRIPTION' | 'SUPPORTING' | 'INSTRUCTIONS';
export interface AccountDocument { id: string; kind: DocumentKind; name: string; bytes: number; updatedAt?: string; body?: string }
export interface PhoneSessionSummary {
  id: string; kind: 'interview' | 'assignment'; title: string; role: string; company: string; model: string;
  startedAt: string; endedAt: string | null; updatedAt: string; questionCount: number;
}
export interface PhoneTurn { id: string; question: string; answer: string; at: string; model?: string; source?: 'voice' | 'typed' | 'photo' }
export interface PhoneSession extends Omit<PhoneSessionSummary, 'questionCount'> { setup: Record<string, unknown>; turns: PhoneTurn[] }

async function post<T>(url: string, body: object, timeoutMs = 15_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
      credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs), keepalive: JSON.stringify(body).length < 60_000 });
  } catch { throw new LiveApiError('unavailable'); }
  if (!response.ok) {
    throw new LiveApiError(response.status === 401 || response.status === 403 ? 'signin' : response.status === 429 ? 'rate'
      : response.status === 400 || response.status === 413 ? 'invalid' : 'unavailable');
  }
  try { return await response.json() as T; } catch { throw new LiveApiError('unavailable'); }
}
const live = <T>(body: object, timeoutMs?: number): Promise<T> => post<T>('/api/account/live', body, timeoutMs);

export const getAccess = (): Promise<AccessGrant> => live<AccessGrant>({ action: 'ACCESS' });
export const getModels = (): Promise<{ models: ModelOption[]; sessionDefaults: SessionDefaults }> => live({ action: 'MODELS' });
export const getDocuments = async (ids: string[]): Promise<AccountDocument[]> =>
  ids.length ? (await live<{ documents: AccountDocument[] }>({ action: 'DOCUMENTS', ids })).documents : [];
export const listSessions = async (): Promise<PhoneSessionSummary[]> =>
  (await live<{ sessions: PhoneSessionSummary[] }>({ action: 'LIST' })).sessions ?? [];
export const readSession = async (id: string): Promise<PhoneSession> => (await live<{ session: PhoneSession }>({ action: 'READ', id })).session;
export const deleteSession = async (id: string): Promise<void> => { await live({ action: 'DELETE', id }); };
export const saveSession = async (payload: object): Promise<void> => { await live(payload, 20_000); };

/** The account's time left and its saved résumé, job description and notes, in one read. */
export async function getHome(): Promise<{ availableMilliseconds: number; unlimited: UnlimitedAccess; documents: AccountDocument[] }> {
  let response: Response;
  try { response = await fetch('/api/account/workspace', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new LiveApiError('unavailable'); }
  if (!response.ok) throw new LiveApiError(response.status === 401 || response.status === 403 ? 'signin' : 'unavailable');
  try {
    const { workspace } = await response.json() as { workspace: { balance: { availableMilliseconds: number }; unlimited?: UnlimitedAccess; documents: AccountDocument[] } };
    return { availableMilliseconds: workspace.balance.availableMilliseconds, unlimited: workspace.unlimited ?? null, documents: workspace.documents };
  } catch { throw new LiveApiError('unavailable'); }
}

/** Saves a résumé, job description or notes typed or loaded on the phone to the account (the same list the Windows app uses). */
export async function saveDocument(input: { kind: DocumentKind; name: string; body: string }): Promise<string> {
  const id = crypto.randomUUID();
  await post('/api/account/workspace', { action: 'SAVE_CONTEXT', operationId: crypto.randomUUID(), id, ...input });
  return id;
}

const MAX_SAVED_CHARS = 440_000;
/** What is stored in the history: the settings (never the résumé text) and every finished question with its answer. */
export function historyPayload(setup: LiveSetup, snapshot: LiveSnapshot, endedAt: string | null): object {
  const kept = snapshot.turns.filter((turn: LiveTurn) => (turn.state === 'done' || turn.state === 'cancelled') && turn.answer.trim())
    .map(turn => ({ id: turn.id, question: turn.question.slice(0, 6_000), answer: turn.answer.slice(0, 24_000), at: turn.at,
      ...(turn.model ? { model: turn.model } : {}), source: turn.source }));
  // The newest questions matter most when a very long session has to be trimmed.
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_SAVED_CHARS) kept.shift();
  const title = setup.title.trim() || (setup.kind === 'assignment' ? 'Assignment' : [setup.role, setup.company].filter(Boolean).join(' · ')) || 'Live session';
  return {
    action: 'SAVE', id: setup.id, kind: setup.kind, title: title.slice(0, 160), role: setup.role.slice(0, 160), company: setup.company.slice(0, 160),
    model: snapshot.modelId.slice(0, 100),
    setup: { language: setup.language, interviewType: setup.interviewType, answerLength: snapshot.answerLength, answerStyle: setup.answerStyle,
      answerPreferences: setup.answerPreferences, autoAnswer: snapshot.autoAnswer, documents: setup.documentNames.slice(0, 8),
      instructions: setup.instructions.slice(0, 4_000) },
    turns: kept.slice(-300),
    startedAt: new Date(snapshot.startedAt || Date.now()).toISOString(), endedAt,
  };
}
