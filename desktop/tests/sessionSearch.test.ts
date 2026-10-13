import { describe, expect, it } from 'vitest';
import type { Session } from '../src/shared/types';
import { filterSessions } from '../src/renderer/services/sessionSearch';

const base = { interviewType: 'mixed' as const, language: 'English', answerStyle: 'Natural', answerLength: 'medium' as const,
  jobDescription: 'Private context', resumeText: '', instructions: '', selectedModel: 'mock', createdAt: '', updatedAt: '' };
const sessions: Session[] = [
  { ...base, id: 'first', title: 'Platform interview', company: 'Acme', role: 'Software Engineer' },
  { ...base, id: 'second', title: 'Design discussion', company: 'Café Labs', role: 'Product Designer' },
  { ...base, id: 'third', title: '面接', company: '', role: 'エンジニア' },
];

describe('Dashboard session search', () => {
  it('returns all sessions for empty or whitespace input', () => {
    expect(filterSessions(sessions, '')).toBe(sessions);
    expect(filterSessions(sessions, '  \t ')).toBe(sessions);
  });
  it('matches case-insensitive terms across name, company and role', () => {
    expect(filterSessions(sessions, '  ACME  platform engineer ')).toEqual([sessions[0]]);
    expect(filterSessions(sessions, 'designer')).toEqual([sessions[1]]);
  });
  it('supports accented and non-Latin names without changing stored data', () => {
    expect(filterSessions(sessions, 'cafe')).toEqual([sessions[1]]);
    expect(filterSessions(sessions, '面接')).toEqual([sessions[2]]);
    expect(sessions[1].company).toBe('Café Labs');
  });
  it('preserves source order and excludes context and nonmatching entries', () => {
    expect(filterSessions(sessions, 'e').map(session => session.id)).toEqual(['first', 'second']);
    expect(filterSessions(sessions, 'acme designer')).toEqual([]);
    expect(filterSessions(sessions, 'private context')).toEqual([]);
    expect(filterSessions([], 'anything')).toEqual([]);
  });
});
