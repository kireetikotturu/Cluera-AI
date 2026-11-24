import { expect, it } from 'vitest';
import { modelLabel } from '../src/renderer/services/modelLabel';
const option = (displayName: string, modelId: string, description: string) => ({ provider: 'gemini' as const, displayName, modelId, description });
it('shows the company next to a model name that does not already say it', () => {
  expect(modelLabel(option('Fast answers', 'gpt-5-mini', 'ChatGPT model'))).toBe('Fast answers');   // the model ID says GPT
  expect(modelLabel(option('Fast answers', 'zeta-1', 'ChatGPT model'))).toBe('Fast answers · ChatGPT');
  expect(modelLabel(option('Thoughtful', 'x-7', 'Claude model'))).toBe('Thoughtful · Claude');
  expect(modelLabel(option('Claude Haiku', 'claude-haiku-5-5', 'Claude model'))).toBe('Claude Haiku');
  expect(modelLabel(option('Quick', 'fast-1', 'Google Gemini model'))).toBe('Quick · Gemini');
  expect(modelLabel(option('Anything', 'abc', 'Cluera Managed default. Server-enforced usage limits apply.'))).toBe('Anything');
});
