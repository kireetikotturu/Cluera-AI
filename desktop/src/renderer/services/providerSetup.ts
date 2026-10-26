import type { ProviderStatus } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

export function providerSetupProblem(status: ProviderStatus, geminiModel = status.defaultGeminiModel): string | null {
  if (status.providerMode !== 'managed') return 'Cluera managed AI configuration is unavailable. Restart Cluera or contact support; personal API keys are not supported.';
  // Server authenticates every managed request; model choices still come from its catalog.
  if (!status.modelOptions?.length) {
    return 'Cluera AI is not configured yet. Ask your administrator to configure and enable the AI providers and approved models in Admin.';
  }
  if (!geminiModel || !status.modelOptions?.some(model => model.modelId === geminiModel)) {
    return 'The selected Gemini model is unavailable or no longer enabled. Choose an enabled model in Settings (or Edit Session for a saved session).';
  }
  if (!status.defaultDeepgramModel || !status.deepgramModelOptions?.some(model => model.modelId === status.defaultDeepgramModel)) {
    return 'Cluera transcription is unavailable. Ask your administrator to configure and enable Deepgram and its approved model in Admin.';
  }
  return null;
}

/** Existing bounded managed catalog check; never starts an AI provider. */
export async function requireSessionProviderSetup(geminiModel?: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // This IPC only reads metadata. Late results cannot overwrite the catalog
    // or open a session after the user has seen a timeout and retried.
    const status = await Promise.race([
      window.electronAPI.getProviderStatus(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The session setup check timed out. Check your connection and try again.')), 10_000); }),
    ]);
    useAppStore.getState().setProviderStatus(status);
    const problem = providerSetupProblem(status, geminiModel);
    if (problem) throw new Error(problem);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
