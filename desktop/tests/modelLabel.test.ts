import { expect, it } from 'vitest';
import { groupModelChoices, modelLabel, modelSpeed, modelTitle, modelVendor } from '../src/renderer/services/modelLabel';
const option = (displayName: string, modelId: string, description: string) => ({ provider: 'gemini' as const, displayName, modelId, description });
it('shows the company next to a model name that does not already say it', () => {
  expect(modelLabel(option('Fast answers', 'gpt-5-mini', 'ChatGPT model'))).toBe('Fast answers');   // the model ID says GPT
  expect(modelLabel(option('Fast answers', 'zeta-1', 'ChatGPT model'))).toBe('Fast answers · ChatGPT');
  expect(modelLabel(option('Thoughtful', 'x-7', 'Claude model'))).toBe('Thoughtful · Claude');
  expect(modelLabel(option('Claude Haiku', 'claude-haiku-5-5', 'Claude model'))).toBe('Claude Haiku');
  expect(modelLabel(option('Quick', 'fast-1', 'Google Gemini model'))).toBe('Quick · Gemini');
  expect(modelLabel(option('Anything', 'abc', 'Cluera Managed default. Server-enforced usage limits apply.'))).toBe('Anything');
});

it('names the company and speed of a model for the picker', () => {
  expect(modelVendor(option('GPT-6 Luna', 'gpt-6-luna', 'ChatGPT model'))).toBe('chatgpt');
  expect(modelVendor(option('Claude Haiku 5.5', 'claude-haiku-5-5', 'x'))).toBe('claude');
  expect(modelVendor(option('Gemini 3.6 Flash', 'gemini-3.6-flash', 'Google Gemini model'))).toBe('gemini');
  expect(modelVendor(option('Other', 'abc', 'x'))).toBeNull();
  expect(modelSpeed(option('a', 'gpt-6-luna', 'x'))).toBe('fast');
  expect(modelSpeed(option('a', 'gemini-3.5-flash-lite', 'x'))).toBe('fast');
  expect(modelSpeed(option('a', 'claude-sonnet-5', 'x'))).toBe('slow');
  expect(modelSpeed(option('a', 'gemini-3.1-pro', 'x'))).toBe('slow');
  expect(modelSpeed(option('a', 'claude-opus-5', 'x'))).toBe('very-slow');
  expect(modelSpeed(option('a', 'o4-mini', 'x'))).toBe('fast');
  expect(modelSpeed(option('a', 'gemini-4-argon', 'x'))).toBeNull();
});

it('prettifies names made from raw model ids and keeps names an admin typed', () => {
  expect(modelTitle(option('ChatGPT gpt-6-luna', 'gpt-6-luna', 'ChatGPT model'))).toBe('GPT-6 Luna');
  expect(modelTitle(option('Claude claude-haiku-5-5', 'claude-haiku-5-5', 'Claude model'))).toBe('Claude Haiku 5.5');
  expect(modelTitle(option('gemini-3.5-flash', 'gemini-3.5-flash', 'x'))).toBe('Gemini 3.5 Flash');
  expect(modelTitle(option('Gemini 3.5 Flash Lite', 'gemini-3.5-flash-lite', 'x'))).toBe('Gemini 3.5 Flash Lite');
  expect(modelTitle(option('My fast answers', 'gpt-5-mini', 'x'))).toBe('My fast answers');
});

it('puts the recommended and fast models first and the rest in a second group', () => {
  const list = [
    option('Sonnet', 'claude-sonnet-5', 'Claude model'), option('Flash', 'gemini-3.5-flash', 'Google Gemini model'),
    option('Opus', 'claude-opus-5', 'Claude model'), option('Luna', 'gpt-6-luna', 'ChatGPT model'), option('Argon', 'gemini-4-argon', 'x'),
  ];
  const groups = groupModelChoices(list, 'gemini-4-argon');
  expect(groups.quick.map((c) => c.model.modelId)).toEqual(['gemini-4-argon', 'gemini-3.5-flash', 'gpt-6-luna']);
  expect(groups.quick[0].recommended).toBe(true);
  expect(groups.more.map((c) => c.model.modelId)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
});
