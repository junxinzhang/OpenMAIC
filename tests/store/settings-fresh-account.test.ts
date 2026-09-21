import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';
import { TTS_PROVIDERS, ASR_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
describe('fresh account provider defaults', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('syncs managed image and video providers on an empty account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          providers: {},
          tts: {},
          asr: {},
          pdf: {},
          webSearch: {},
          image: { 'openrouter-image': { models: ['test-image'] } },
          video: { 'openrouter-video': { models: ['test-video'] } },
        }),
      ),
    );
    await useSettingsStore.getState().fetchServerProviders();
    const state = useSettingsStore.getState();
    expect(state.imageProvidersConfig['openrouter-image'].isServerConfigured).toBe(true);
    expect(state.videoProvidersConfig['openrouter-video'].isServerConfigured).toBe(true);
    expect(state.imageProvidersConfig['openrouter-image'].customModels).toEqual([
      { id: 'test-image', name: 'test-image' },
    ]);
    expect(state.videoProvidersConfig['openrouter-video'].customModels).toEqual([
      { id: 'test-video', name: 'test-video' },
    ]);
  });
  it('initializes every registered provider before the first server sync', async () => {
    const state = useSettingsStore.getState();
    for (const [name, registry, config] of [
      ['tts', TTS_PROVIDERS, state.ttsProvidersConfig],
      ['asr', ASR_PROVIDERS, state.asrProvidersConfig],
      ['image', IMAGE_PROVIDERS, state.imageProvidersConfig],
      ['video', VIDEO_PROVIDERS, state.videoProvidersConfig],
      ['pdf', PDF_PROVIDERS, state.pdfProvidersConfig],
    ] as const) {
      for (const key of Object.keys(registry))
        expect(config[key as keyof typeof config], `${name}:${key}`).toBeDefined();
    }
  });
});
