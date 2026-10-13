import type { ProviderStatus } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

export function providerSetupProblem(status: ProviderStatus, geminiModel = status.defaultGeminiModel): string | null {
  if (status.providerMode !== 'managed') return 'Cluera managed AI configuration is unavailable. Restart Cluera or contact support; personal API keys are not supported.';
  // Server authenticates every managed request; model choices still come from its catalog.
  if (!geminiModel || !status.modelOptions?.some(model => model.modelId === geminiModel)) {
    return 'The selected Gemini model is unavailable or no longer enabled. Choose an enabled model in Settings (or Edit Session for a saved session).';
  }
  if (status.deepgramModelOptions?.length && (!status.defaultDeepgramModel || !status.deepgramModelOptions.some(model => model.modelId === status.defaultDeepgramModel))) {
    return 'The selected Deepgram model is unavailable or no longer enabled. Choose an enabled model in Settings.';
  }
  return null;
}

/** Existing bounded managed catalog check; never starts an AI provider. */
export async function requireSessionProviderSetup(geminiModel?: string): Promise<void> {
  const status = await window.electronAPI.getProviderStatus();
  useAppStore.getState().setProviderStatus(status);
  const problem = providerSetupProblem(status, geminiModel);
  if (problem) throw new Error(problem);
}
