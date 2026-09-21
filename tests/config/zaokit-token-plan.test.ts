import { describe, it, expect, vi } from 'vitest';
import { applyTokenPlan, removeTokenPlan } from '@/lib/config/apply-token-plan';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { useSettingsStore } from '@/lib/store/settings';
import { generateImage } from '@/lib/media/image-providers';

const preset = TOKEN_PLAN_PRESETS.find((p) => p.id === 'zaokit')!;

describe('Zaokit token plan', () => {
  it('applies and removes its own settings without changing other providers', () => {
    const before = useSettingsStore.getState();
    const openai = before.providersConfig.openai;
    const openaiImage = before.imageProvidersConfig['openai-image'];
    const result = applyTokenPlan(preset, 'test-only-key', before);
    expect(result.every((r) => r.status === 'lit')).toBe(true);
    let state = useSettingsStore.getState();
    expect(state.providersConfig.zaokit.apiKey).toBe('test-only-key');
    expect(state.providersConfig.zaokit.models.length).toBeGreaterThan(0);
    expect(state.imageProviderId).toBe('zaokit-image');
    expect(state.imageModelId).toBe('gpt-image-2');
    for (const config of [
      state.imageProvidersConfig['zaokit-image'],
      state.ttsProvidersConfig['zaokit-tts'],
      state.asrProvidersConfig['zaokit-asr'],
    ]) {
      expect(config).toMatchObject({
        apiKey: 'test-only-key',
        baseUrl: 'https://api.zaokit.com/v1',
        enabled: true,
      });
    }
    expect(removeTokenPlan(preset, state).every((r) => r.status === 'lit')).toBe(true);
    state = useSettingsStore.getState();
    expect(state.providersConfig.zaokit.apiKey).toBe('');
    expect(state.asrProvidersConfig['zaokit-asr'].enabled).toBe(false);
    expect(state.providersConfig.openai).toEqual(openai);
    expect(state.imageProvidersConfig['openai-image']).toEqual(openaiImage);
  });

  it('sends image requests to Zaokit when no address is explicitly saved', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateImage(
        { providerId: 'zaokit-image', apiKey: 'test-only-key', model: 'gpt-image-2' },
        { prompt: 'A blue square' },
      );
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.zaokit.com/v1/images/generations');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-only-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
