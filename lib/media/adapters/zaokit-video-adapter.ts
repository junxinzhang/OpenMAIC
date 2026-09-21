import { zaokitFetch } from '@/lib/zaokit/api';
import { runPolledTask, type PollResult } from '../polled-task';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

interface VideoJob {
  id?: string;
  status?: string;
  error?: { message?: string };
}

export async function testZaokitVideoConnectivity(config: VideoGenerationConfig) {
  try {
    await zaokitFetch(`/models/${encodeURIComponent(config.model || 'sora-2')}`, config, {
      signal: AbortSignal.timeout(10_000),
    });
    return { success: true, message: 'Zaokit model connection successful' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateWithZaokitVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const width = options.aspectRatio === '9:16' ? 720 : 1280;
  const height = options.aspectRatio === '9:16' ? 1280 : 720;
  const duration = options.duration || 4;
  const resolveJob = async (job: VideoJob): Promise<PollResult<VideoGenerationResult>> => {
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired')
      return { status: 'failed', message: job.error?.message || `Zaokit video ${job.status}` };
    if (job.status !== 'completed') return { status: 'pending', detail: job.status };
    if (!job.id) throw new Error('Zaokit video response is missing its ID');
    const response = await zaokitFetch(`/videos/${encodeURIComponent(job.id)}/content`, config, {
      signal: options.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('video/')) throw new Error('Zaokit returned invalid video content');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error('Zaokit returned an empty video');
    return {
      status: 'done',
      result: {
        url: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`,
        width,
        height,
        duration,
      },
    };
  };
  return runPolledTask({
    label: 'Zaokit video generation',
    intervalMs: 10_000,
    maxAttempts: 60,
    signal: options.signal,
    submit: async () => {
      const form = new FormData();
      form.set('model', config.model || 'sora-2');
      form.set('prompt', options.prompt);
      form.set('seconds', String(duration));
      form.set('size', `${width}x${height}`);
      const response = await zaokitFetch('/videos', config, {
        method: 'POST',
        body: form,
        signal: options.signal,
      });
      const job: VideoJob = await response.json();
      const result = await resolveJob(job);
      if (result.status !== 'pending') return result;
      if (!job.id) throw new Error('Zaokit video response is missing its ID');
      return { status: 'submitted', taskId: job.id };
    },
    poll: async (id) => {
      const response = await zaokitFetch(`/videos/${encodeURIComponent(id)}`, config, {
        signal: options.signal,
      });
      return resolveJob(await response.json());
    },
  });
}
