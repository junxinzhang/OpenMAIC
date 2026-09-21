import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWithZaokit } from '@/lib/web-search/zaokit';
import { parseWithZaokit } from '@/lib/pdf/zaokit';
import { generateWithZaokitVideo } from '@/lib/media/adapters/zaokit-video-adapter';
import { zaokitBaseUrl } from '@/lib/zaokit/api';

const config = { apiKey: 'test-only-key', baseUrl: 'https://api.zaokit.com' };
const response = (text: string, annotations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text, annotations }] }],
    }),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Zaokit compatible adapters', () => {
  it('normalizes root and versioned addresses without duplicating v1', () => {
    expect(zaokitBaseUrl(config.baseUrl)).toBe('https://api.zaokit.com/v1');
    expect(zaokitBaseUrl('https://api.zaokit.com/v1/')).toBe('https://api.zaokit.com/v1');
  });
  it('extracts PDF text and sends PDF bytes to the configured gateway', async () => {
    const fetch = vi.fn().mockResolvedValue(response('# Document\nHello'));
    vi.stubGlobal('fetch', fetch);
    expect(
      await parseWithZaokit({ providerId: 'zaokit', ...config }, Buffer.from('%PDF-test')),
    ).toEqual({ text: '# Document\nHello', images: [] });
    expect(fetch.mock.calls[0][0]).toBe('https://api.zaokit.com/v1/responses');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.input[0].content[0].file_data).toBe('data:application/pdf;base64,JVBERi10ZXN0');
  });
  it('returns only real HTTP citations and rejects uncited search answers', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('Answer', [
          { type: 'url_citation', url: 'https://example.com/', title: 'Example' },
          { type: 'url_citation', url: 'javascript:alert(1)' },
        ]),
      )
      .mockResolvedValueOnce(response('Uncited'));
    vi.stubGlobal('fetch', fetch);
    const result = await searchWithZaokit({ ...config, query: 'test' });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://example.com/');
    expect(JSON.parse(fetch.mock.calls[0][1].body).tools).toEqual([{ type: 'web_search' }]);
    await expect(searchWithZaokit({ ...config, query: 'test' })).rejects.toThrow(
      'no verifiable sources',
    );
  });
  it('polls a video job and downloads the finished video using the same gateway', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-1', status: 'queued' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-1', status: 'completed' })))
      .mockResolvedValueOnce(
        new Response('test-video', { headers: { 'content-type': 'video/mp4' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const promise = generateWithZaokitVideo(
      { ...config, providerId: 'zaokit-video', model: 'sora-2' },
      { prompt: 'A square', duration: 4 },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const video = await promise;
    expect(video.url).toMatch(/^data:video\/mp4;base64,/);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://api.zaokit.com/v1/videos',
      'https://api.zaokit.com/v1/videos/job-1',
      'https://api.zaokit.com/v1/videos/job-1/content',
    ]);
    expect(fetch.mock.calls[0][1].body.get('seconds')).toBe('4');
  });
  it('does not treat an API error or redirect as successful output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 302 })));
    await expect(
      parseWithZaokit({ providerId: 'zaokit', ...config }, Buffer.from('test')),
    ).rejects.toThrow('302');
  });
});
