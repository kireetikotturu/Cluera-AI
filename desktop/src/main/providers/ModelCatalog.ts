import type { ProviderModelOption, ProviderName } from '../../shared/types';
import { MANAGED_GEMINI_MODEL, MANAGED_DEEPGRAM_MODEL } from '../../shared/managedProviders';

export class ModelCatalog {
  private remoteModels: ProviderModelOption[] | null = null;
  private lastAttempt = 0;
  private lastSuccess = 0;
  private pendingRefresh: Promise<void> | null = null;
  private approvedDefaults: Partial<Record<ProviderName, string>> = {};

  constructor(private readonly serverUrl: string, private readonly defaults: {
    gemini: string; deepgram: string;
  }, private readonly fetcher: typeof fetch = fetch, private readonly allowUnverifiedLocalDefaults = false,
    private readonly managedMode: () => boolean = () => false,
    private readonly endpointPath: '/api/public/models' | '/api/account/models' = '/api/public/models') {}

  setLocalDefault(provider: ProviderName, modelId: string): void { this.defaults[provider] = modelId; }
  defaultModel(provider: ProviderName): string { return this.hasCurrentRemoteModels() ? this.approvedDefaults[provider] ?? this.defaults[provider] : this.defaults[provider]; }

  async refresh(force = false): Promise<void> {
    if (this.managedMode()) return;
    if (this.pendingRefresh) {
      if (!force && this.hasCurrentRemoteModels()) return;
      return this.pendingRefresh;
    }
    if (!force && Date.now() - this.lastAttempt < 60_000) return;
    this.lastAttempt = Date.now();
    const task = this.fetchModels().finally(() => { this.pendingRefresh = null; });
    this.pendingRefresh = task;
    if (!force && this.hasCurrentRemoteModels()) return;
    await task;
  }

  private hasCurrentRemoteModels(): boolean {
    return this.remoteModels !== null && this.lastSuccess > 0 && Date.now() - this.lastSuccess <= 5 * 60_000;
  }

  private async fetchModels(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const endpoint = new URL(this.endpointPath, this.serverUrl);
      const local = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
      if (endpoint.protocol !== 'https:' && !local) return;
      const response = await this.fetcher(endpoint, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json() as { models?: unknown };
      if (!Array.isArray(body.models) || body.models.length > 500) return;
      const parsed: ProviderModelOption[] = [];
      const approvedDefaults: Partial<Record<ProviderName, string>> = {};
      const seen = new Set<string>();
      for (const item of body.models) {
        if (!item || typeof item !== 'object') return;
        const model = item as Record<string, unknown>;
        if ((model.provider !== 'gemini' && model.provider !== 'deepgram')
          || typeof model.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(model.modelId)
          || typeof model.displayName !== 'string' || model.displayName.trim().length < 2 || model.displayName.length > 80
          || typeof model.description !== 'string' || model.description.length > 240
          || typeof model.enabled !== 'boolean') return;
        const key = `${model.provider}:${model.modelId}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (!model.enabled) continue;
        if (model.isDefault === true) {
          if (approvedDefaults[model.provider]) return;
          approvedDefaults[model.provider] = model.modelId;
        }
        parsed.push({ provider: model.provider, modelId: model.modelId, displayName: model.displayName,
          description: model.description });
      }
      this.remoteModels = parsed;
      this.approvedDefaults = approvedDefaults;
      this.lastSuccess = Date.now();
    } catch { /* Retain the last validated catalog during network outages. */ }
    finally { clearTimeout(timer); }
  }

  choices(provider: ProviderName): ProviderModelOption[] {
    if (this.managedMode()) {
      const modelId = provider === 'gemini' ? MANAGED_GEMINI_MODEL : MANAGED_DEEPGRAM_MODEL;
      return [{ provider, modelId, displayName: modelId, description: 'Cluera Managed default. Server-enforced usage limits apply.' }];
    }
    if (this.remoteModels && this.hasCurrentRemoteModels()) {
      return this.remoteModels.filter((model) => model.provider === provider);
    }
    if (!this.allowUnverifiedLocalDefaults) return [];
    const modelId = this.defaults[provider];
    return [{ provider, modelId, displayName: provider === 'gemini' ? 'Current Gemini default' : 'Flux General English',
      description: 'Local default while model choices are unavailable.' }];
  }

  isAllowed(provider: ProviderName, modelId: string): boolean {
    return this.choices(provider).some((model) => model.modelId === modelId);
  }
}
