import type { ProvidersConfig } from '@/lib/types/settings';

/** Models explicitly retired from this deployment's selectable catalog. */
export function isRetiredModel(id: string): boolean {
  return /(?:^|[/:])gpt-5\.4(?:$|[-:@])/i.test(id.trim());
}

export function withoutRetiredModels(config: ProvidersConfig): ProvidersConfig {
  return Object.fromEntries(
    Object.entries(config).map(([id, provider]) => [
      id,
      {
        ...provider,
        models: (provider.models || []).filter((model) => !isRetiredModel(model.id)),
        ...(provider.serverModels
          ? { serverModels: provider.serverModels.filter((model) => !isRetiredModel(model)) }
          : {}),
      },
    ]),
  ) as ProvidersConfig;
}
