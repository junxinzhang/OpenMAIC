import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/ai/providers';
import { isRetiredModel } from '@/lib/ai/retired-models';
import { useSettingsStore } from '@/lib/store/settings';

describe('retired GPT-5.4 family', () => {
  it('recognizes all family variants without matching adjacent versions', () => {
    for (const id of [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.4-pro',
      'openai/gpt-5.4-2026-01-01',
    ])
      expect(isRetiredModel(id)).toBe(true);
    for (const id of ['gpt-5.5', 'gpt-5.6-terra', 'gpt-5.40'])
      expect(isRetiredModel(id)).toBe(false);
    expect(PROVIDERS.openai.models.some((m) => isRetiredModel(m.id))).toBe(false);
  });
  it('removes stale saved models and moves the old selection to a supported model', () => {
    const original = useSettingsStore.getState();
    try {
      useSettingsStore.setState({ providerId: 'openai', modelId: 'gpt-5.4-mini' });
      original.setProviderConfig('openai', {
        apiKey: 'test-only',
        models: [
          { id: 'gpt-5.4-mini', name: 'Old' },
          { id: 'gpt-5.6-terra', name: 'Terra' },
        ],
      });
      expect(useSettingsStore.getState().modelId).toBe('gpt-5.6-terra');
      expect(useSettingsStore.getState().providersConfig.openai.models.map((m) => m.id)).toEqual([
        'gpt-5.6-terra',
      ]);
      const merge = useSettingsStore.persist.getOptions().merge!;
      const restored = merge(
        {
          providersConfig: {
            ...original.providersConfig,
            openai: {
              ...original.providersConfig.openai,
              apiKey: 'test-only',
              models: [{ id: 'gpt-5.4-pro', name: 'Old' }],
            },
          },
          providerId: 'openai',
          modelId: 'gpt-5.4-pro',
        },
        original,
      );
      expect(restored.providersConfig.openai.models.some((m) => isRetiredModel(m.id))).toBe(false);
      expect(isRetiredModel(restored.modelId)).toBe(false);
    } finally {
      useSettingsStore.setState(original);
    }
  });
});
