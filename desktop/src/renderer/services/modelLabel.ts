import type { ProviderModelOption } from '../../shared/types';

/** The server describes every answer model as "<ChatGPT|Claude|Google Gemini> model". Show that company next
 * to the name when the name does not already say it, so similar names are never confusing. */
const VENDORS: Array<{ description: string; label: string; tokens: string[] }> = [
  { description: 'ChatGPT model', label: 'ChatGPT', tokens: ['gpt', 'openai', 'chatgpt', 'o1', 'o3', 'o4'] },
  { description: 'Claude model', label: 'Claude', tokens: ['claude', 'anthropic', 'haiku', 'sonnet', 'opus'] },
  { description: 'Google Gemini model', label: 'Gemini', tokens: ['gemini', 'google'] },
];

export function modelLabel(model: Pick<ProviderModelOption, 'displayName' | 'modelId' | 'description'>): string {
  const vendor = VENDORS.find((entry) => entry.description === model.description);
  if (!vendor) return model.displayName;
  const text = `${model.displayName} ${model.modelId}`.toLowerCase();
  return vendor.tokens.some((token) => text.includes(token)) ? model.displayName : `${model.displayName} · ${vendor.label}`;
}
