import { describe, expect, it } from 'vitest';
import { fastThinkingConfig } from '../src/main/llm/geminiThinking';

describe('Gemini low-latency thinking configuration', () => {
  it.each(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])('uses a zero budget for %s', model => {
    expect(fastThinkingConfig(model)).toEqual({ thinkingBudget: 0 });
  });
  it.each(['gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'])('uses minimal thinking for %s', model => {
    expect(fastThinkingConfig(model)).toEqual({ thinkingLevel: 'minimal' });
  });
  it('does not impose unsupported thinking settings on unrelated models', () => {
    expect(fastThinkingConfig('gemini-2.0-flash')).toBeUndefined();
    expect(fastThinkingConfig('gemini-3.1-pro-preview')).toBeUndefined();
  });
});
