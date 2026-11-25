import type { ProviderModelOption } from '../../../../desktop/src/shared/types';
import { groupModelChoices, modelTitle } from '../../../../desktop/src/renderer/services/modelLabel';
import type { ModelOption } from '../../../lib/live/liveApi';

const DESCRIPTION = { gemini: 'Google Gemini model', openai: 'ChatGPT model', anthropic: 'Claude model' } as const;

/** The model as the Windows app's picker names it, so one model reads the same on both. */
const asOption = (model: ModelOption): ProviderModelOption => ({
  provider: 'gemini', modelId: model.modelId, displayName: model.displayName, description: DESCRIPTION[model.provider], tag: model.tag,
});

export function modelChoiceLabel(model: ModelOption): string {
  const option = asOption(model);
  const { quick, more } = groupModelChoices([option], model.isDefault ? model.modelId : undefined);
  const tag = [...quick, ...more][0]?.tag;
  return `${modelTitle(option)}${tag ? ` · ${tag.text}` : ''}`;
}

/** Recommended and fast models first (the same grouping as the Windows app), then the rest. */
export function orderedModels(models: ModelOption[]): { quick: ModelOption[]; more: ModelOption[] } {
  const byId = new Map(models.map(model => [model.modelId, model]));
  const recommended = models.find(model => model.isDefault)?.modelId;
  const groups = groupModelChoices(models.map(asOption), recommended);
  const pick = (choices: typeof groups.quick): ModelOption[] => choices.map(choice => byId.get(choice.model.modelId)).filter((value): value is ModelOption => Boolean(value));
  return { quick: pick(groups.quick), more: pick(groups.more) };
}
