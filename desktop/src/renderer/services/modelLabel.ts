import type { ProviderModelOption } from '../../shared/types';

/** The server describes every answer model as "<ChatGPT|Claude|Google Gemini> model". Show that company next
 * to the name when the name does not already say it, so similar names are never confusing. */
export type ModelVendor = 'chatgpt' | 'claude' | 'gemini';
const VENDORS: Array<{ id: ModelVendor; description: string; label: string; tokens: string[] }> = [
  { id: 'chatgpt', description: 'ChatGPT model', label: 'ChatGPT', tokens: ['gpt', 'openai', 'chatgpt', 'o1', 'o3', 'o4'] },
  { id: 'claude', description: 'Claude model', label: 'Claude', tokens: ['claude', 'anthropic', 'haiku', 'sonnet', 'opus'] },
  { id: 'gemini', description: 'Google Gemini model', label: 'Gemini', tokens: ['gemini', 'google'] },
];

type ModelLike = Pick<ProviderModelOption, 'displayName' | 'modelId' | 'description'>;

export function modelLabel(model: ModelLike): string {
  const vendor = VENDORS.find((entry) => entry.description === model.description);
  if (!vendor) return model.displayName;
  const text = `${model.displayName} ${model.modelId}`.toLowerCase();
  return vendor.tokens.some((token) => text.includes(token)) ? model.displayName : `${model.displayName} · ${vendor.label}`;
}

/** The company behind a model, from the server's description first and the model name second. */
export function modelVendor(model: ModelLike): ModelVendor | null {
  const byDescription = VENDORS.find((entry) => entry.description === model.description);
  if (byDescription) return byDescription.id;
  const text = `${model.displayName} ${model.modelId}`.toLowerCase();
  return VENDORS.find((entry) => entry.tokens.some((token) => text.includes(token)))?.id ?? null;
}

/** A tidy name for the picker. Names the Admin typed are kept; names made from the raw model id are prettified. */
export function modelTitle(model: ModelLike): string {
  const id = model.modelId.trim();
  const generated = model.displayName === id || /^(?:ChatGPT|Claude|Gemini|Google Gemini) /i.test(model.displayName) && model.displayName.toLowerCase().endsWith(id.toLowerCase());
  if (!generated || !id) return model.displayName;
  const parts = id.replace(/^models\//, '').split(/[-_\s]+/).filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    const last = words[words.length - 1];
    if (/^\d+$/.test(part) && last && /^\d+(?:\.\d+)*$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else words.push(part);
  }
  const pretty = words.map((word) => (word.toLowerCase() === 'gpt' ? 'GPT' : /^\d/.test(word) || /^o\d/i.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
  if (pretty[0] === 'GPT' && pretty[1] && /^\d/.test(pretty[1])) pretty.splice(0, 2, `GPT-${pretty[1]}`);
  return pretty.join(' ');
}

export type ModelSpeed = 'fast' | 'slow' | 'very-slow' | null;

/** A plain hint about how quickly a model usually starts answering, read from its name. */
export function modelSpeed(model: ModelLike): ModelSpeed {
  const text = `${model.displayName} ${model.modelId}`.toLowerCase();
  const has = (words: string[]): boolean => words.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text));
  if (has(['opus', 'ultra', 'deep', 'research'])) return 'very-slow';
  if (has(['pro', 'sonnet', 'terra', 'thinking', 'reasoning'])) return 'slow';
  if (has(['flash', 'lite', 'mini', 'nano', 'haiku', 'luna', 'fast', 'instant', 'turbo', 'spark'])) return 'fast';
  if (has(['o1', 'o3', 'o4'])) return 'slow';
  return null;
}

export const SPEED_LABEL: Record<Exclude<ModelSpeed, null>, string> = { fast: 'Fast', slow: 'Slow', 'very-slow': 'Very slow' };

export interface ModelChoice<T extends ModelLike> { model: T; vendor: ModelVendor | null; speed: ModelSpeed; recommended: boolean }

/** Two groups for the picker: the recommended model and the quick ones first, everything else after. */
export function groupModelChoices<T extends ModelLike>(models: T[], recommendedId?: string): { quick: ModelChoice<T>[]; more: ModelChoice<T>[] } {
  const choices = models.map((model): ModelChoice<T> => ({
    model, vendor: modelVendor(model), speed: modelSpeed(model), recommended: model.modelId === recommendedId,
  }));
  const rank = (choice: ModelChoice<T>): number => (choice.recommended ? 0 : choice.speed === 'fast' ? 1 : choice.speed === null ? 2 : choice.speed === 'slow' ? 3 : 4);
  const sorted = choices.map((choice, index) => ({ choice, index })).sort((a, b) => rank(a.choice) - rank(b.choice) || a.index - b.index).map((entry) => entry.choice);
  return {
    quick: sorted.filter((choice) => choice.recommended || choice.speed === 'fast'),
    more: sorted.filter((choice) => !choice.recommended && choice.speed !== 'fast'),
  };
}
