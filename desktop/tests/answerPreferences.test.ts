import { describe, expect, it } from 'vitest';
import { answerPreferenceRules, DEFAULT_ANSWER_PREFERENCES, DEFAULT_SESSION_CONTEXT, normalizeAnswerPreferences, serializeAnswerPreferences } from '../src/shared/answerPreferences';
import { sessionInputSchema } from '../src/shared/schemas';
import { PromptBuilder } from '../src/main/llm/PromptBuilder';
import type { AnswerContext, Session } from '../src/shared/types';

const base: Session = { id: '1', title: 'Test', role: 'Engineer', company: 'Acme', interviewType: 'mixed', language: 'English', answerStyle: 'Natural', answerLength: 'medium', jobDescription: '', resumeText: '', instructions: '', selectedModel: 'model-1', createdAt: '', updatedAt: '' };
const promptFor = (answerPreferences?: Session['answerPreferences']): string => {
  const session = { ...base, answerPreferences };
  const context: AnswerContext = { question: 'What is React?', intent: 'TECHNICAL_QUESTION', recentConversation: [], resumeContext: [], jobContext: [], documentContext: [], instructions: '', session };
  return new PromptBuilder().build(context);
};

describe('answer preferences', () => {
  it('defaults to script + bullets with filler words and everything else off', () => {
    expect(DEFAULT_ANSWER_PREFERENCES).toEqual({ fullScript: false, scriptWithBullets: true, bullets: false, fillerWords: true });
    expect(normalizeAnswerPreferences(undefined)).toEqual(DEFAULT_ANSWER_PREFERENCES);
    expect(normalizeAnswerPreferences('')).toEqual(DEFAULT_ANSWER_PREFERENCES);
    expect(normalizeAnswerPreferences('{not json')).toEqual(DEFAULT_ANSWER_PREFERENCES);
    expect(normalizeAnswerPreferences({ bullets: 'yes', fullScript: true })).toEqual({ ...DEFAULT_ANSWER_PREFERENCES, fullScript: true });
  });
  it('round-trips through the stored text', () => {
    const prefs = { fullScript: true, scriptWithBullets: false, bullets: true, fillerWords: false };
    expect(normalizeAnswerPreferences(serializeAnswerPreferences(prefs))).toEqual(prefs);
  });
  it('gives each format its own instruction', () => {
    const only = (key: 'fullScript' | 'scriptWithBullets' | 'bullets') => ({ fullScript: false, scriptWithBullets: false, bullets: false, fillerWords: true, [key]: true });
    expect(answerPreferenceRules(only('fullScript'))).toContain('read word for word');
    expect(answerPreferenceRules(only('fullScript'))).toContain('Do not use bullet points');
    expect(answerPreferenceRules(only('scriptWithBullets'))).toContain('one short opening line');
    expect(answerPreferenceRules(only('bullets'))).toContain('only short bullet points');
    expect(answerPreferenceRules({ ...only('fullScript'), scriptWithBullets: true })).toContain('Key points');
  });
  it('falls back to the default format when nothing is selected', () => {
    const none = { fullScript: false, scriptWithBullets: false, bullets: false, fillerWords: false };
    expect(answerPreferenceRules(none)).toContain('one short opening line');
    expect(answerPreferenceRules(none)).toContain('without filler words');
  });
  it('switches the speech style with the filler words toggle', () => {
    expect(answerPreferenceRules({ ...DEFAULT_ANSWER_PREFERENCES, fillerWords: true })).toContain('connecting words');
    expect(answerPreferenceRules({ ...DEFAULT_ANSWER_PREFERENCES, fillerWords: false })).toContain('without filler words');
  });
  it('is part of every generated answer prompt, after the general style hints', () => {
    const prompt = promptFor({ fullScript: true, scriptWithBullets: false, bullets: false, fillerWords: false });
    expect(prompt).toContain('ANSWER FORMAT chosen by the candidate');
    expect(prompt.indexOf('ANSWER FORMAT')).toBeGreaterThan(prompt.indexOf('Begin with the direct definition'));
    expect(prompt).toContain('read word for word');
    expect(promptFor(undefined)).toContain('one short opening line');
  });
  it('is accepted by the session schema and the default context is plain text', () => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = base;
    const parsed = sessionInputSchema.parse({ ...input, answerPreferences: DEFAULT_ANSWER_PREFERENCES });
    expect(parsed.answerPreferences).toEqual(DEFAULT_ANSWER_PREFERENCES);
    expect(() => sessionInputSchema.parse({ ...input, answerPreferences: { fullScript: 1 } })).toThrow();
    expect(DEFAULT_SESSION_CONTEXT.length).toBeGreaterThan(80);
    expect(DEFAULT_SESSION_CONTEXT).toMatch(/simple English/);
  });
});
