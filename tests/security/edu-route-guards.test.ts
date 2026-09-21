import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({
  user: { id: 'alice', email: 'alice@example.test' } as { id: string; email: string } | null,
  job: { id: 'job1234567', ownerId: 'alice', status: 'running', step: 'generate' },
  classroom: { id: 'course1234', ownerId: 'alice', published: false },
  reserve: vi.fn(),
  release: vi.fn(),
  settle: vi.fn(),
  after: vi.fn(),
  run: vi.fn(),
  create: vi.fn(),
  usage: vi.fn(),
  proxy: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/auth/session', () => ({ getRequestUser: async () => state.user }));
vi.mock('@/lib/auth/db', () => ({
  getAccountPool: () => ({
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT 1'))
        return {
          rowCount: params?.[0] === 'render-a' && params?.[1] === 'alice' ? 1 : 0,
          rows: [],
        };
      if (sql.startsWith('SELECT user_id'))
        return { rowCount: state.rows.length, rows: state.rows };
      return { rowCount: 0, rows: [] };
    },
  }),
}));
vi.mock('@/lib/billing/store', () => ({
  reserveCredits: state.reserve,
  releaseCredits: state.release,
  settleCredits: state.settle,
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: state.after,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: () => 'https://edu.example',
  readClassroom: async () => state.classroom,
  isValidClassroomId: () => true,
  isValidClassroomJobId: () => true,
  persistClassroom: vi.fn(),
  generateClassroomId: () => 'new-course',
  CLASSROOM_ID_MAX_ATTEMPTS: 3,
  ClassroomAlreadyExistsError: class extends Error {},
}));
vi.mock('@/lib/server/classroom-generation', () => ({ generateClassroom: vi.fn() }));
vi.mock('@/lib/server/classroom-job-runner', () => ({ runClassroomGenerationJob: state.run }));
vi.mock('@/lib/server/classroom-job-store', () => ({
  isValidClassroomJobId: () => true,
  readClassroomGenerationJob: async () => state.job,
  createClassroomGenerationJob: state.create,
}));
vi.mock('@/lib/server/usage-storage', () => ({ readUsageRecords: state.usage }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: state.proxy }));
vi.mock('@/lib/server/render-service', () => ({
  resolveRenderServiceUrl: () => ({ url: 'http://render.internal' }),
}));
vi.mock('@/lib/server/sanitize-scene-content', () => ({
  sanitizeSceneContent: (value: unknown) => value,
}));
import { proxy as middleware } from '@/proxy';
import { canReadLegacyClassroom } from '@/lib/server/classroom-access';
import { ownsRenderJob, reconcileRenderJob } from '@/lib/server/render-account';
import { GET as classroomGet } from '@/app/api/classroom/route';
import { GET as jobGet } from '@/app/api/generate-classroom/[jobId]/route';
import { POST as generatePost } from '@/app/api/generate-classroom/route';
import { GET as usageGet } from '@/app/api/usage/route';
import {
  GET as renderGet,
  DELETE as renderDelete,
} from '@/app/api/export-video/render/[jobId]/route';
import { GET as renderDownload } from '@/app/api/export-video/render/[jobId]/download/route';
import { POST as renderPost } from '@/app/api/export-video/render/route';
beforeEach(() => {
  vi.clearAllMocks();
  state.reserve.mockResolvedValue(undefined);
  state.release.mockResolvedValue(undefined);
  state.settle.mockResolvedValue(undefined);
  process.env.EDU_AUTH_ENABLED = 'true';
  process.env.EDU_BILLING_ENABLED = 'true';
  state.user = { id: 'alice', email: 'alice@example.test' };
  state.rows = [];
  state.classroom = { id: 'course1234', ownerId: 'alice', published: false };
  state.job = { id: 'job1234567', ownerId: 'alice', status: 'running', step: 'generate' };
  state.create.mockResolvedValue({ status: 'queued', step: 'queued', message: 'queued' });
});
const req = (url = 'https://edu.example/api') => new NextRequest(url);
const context = { params: Promise.resolve({ jobId: 'job1234567' }) };
describe('Edu account isolation', () => {
  it('keeps historic ownerless classrooms private and preserves explicit publication', () => {
    expect(canReadLegacyClassroom({}, 'alice')).toBe(false);
    expect(canReadLegacyClassroom({ ownerId: 'alice' }, 'bob')).toBe(false);
    expect(canReadLegacyClassroom({ ownerId: 'alice' }, 'alice')).toBe(true);
    expect(canReadLegacyClassroom({ published: true })).toBe(true);
  });
  it('returns no private classroom contents to another account or guest', async () => {
    state.user = { id: 'bob', email: 'bob@example.test' };
    expect(
      (await classroomGet(req('https://edu.example/api/classroom?id=course1234'))).status,
    ).toBe(404);
    state.user = null;
    expect(
      (await classroomGet(req('https://edu.example/api/classroom?id=course1234'))).status,
    ).toBe(404);
  });
  it('denies another account legacy background job status', async () => {
    state.user = { id: 'bob', email: 'bob@example.test' };
    expect((await jobGet(req(), context)).status).toBe(404);
    state.user = { id: 'alice', email: 'alice@example.test' };
    expect((await jobGet(req(), context)).status).toBe(200);
  });
  it('does not read the unscoped usage log in account mode', async () => {
    expect((await usageGet(req())).status).toBe(403);
    expect(state.usage).not.toHaveBeenCalled();
  });
  it('scopes render lookup to server-verified user and blocks status, cancel, download before upstream', async () => {
    expect(await ownsRenderJob(req(), 'render-a')).toBe(true);
    state.user = { id: 'bob', email: 'bob@example.test' };
    expect(await ownsRenderJob(req(), 'render-a')).toBe(false);
    for (const route of [renderGet, renderDelete, renderDownload])
      expect((await route(req(), { params: Promise.resolve({ jobId: 'render-a' }) })).status).toBe(
        404,
      );
    expect(state.proxy).not.toHaveBeenCalled();
  });
});
describe('background billing boundaries', () => {
  it('reserves queued classroom work but does not charge before worker execution', async () => {
    const response = await generatePost(
      new NextRequest('https://edu.example/api/generate-classroom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requirement: 'A small classroom' }),
      }),
    );
    expect(response.status).toBe(202);
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[0][2]).toMatchObject({ ownerId: 'alice' });
    expect(state.after).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.settle).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });
  it('returns pre-execution creation failure without charging and releases reservation', async () => {
    state.create.mockRejectedValueOnce(new Error('disk full'));
    const response = await generatePost(
      new NextRequest('https://edu.example/api/generate-classroom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requirement: 'A small classroom' }),
      }),
    );
    expect(response.status).toBe(500);
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.settle).not.toHaveBeenCalled();
    expect(state.after).not.toHaveBeenCalled();
  });
  it('ignores nonterminal render states and reconciles confirmed completion', async () => {
    state.rows = [{ user_id: 'alice', operation_id: 'render:alice:1' }];
    await reconcileRenderJob('render-a', 'running');
    expect(state.settle).not.toHaveBeenCalled();
    await reconcileRenderJob('render-a', 'succeeded');
    expect(state.settle).toHaveBeenCalledWith('alice', 'render:alice:1');
  });
  it('keeps async render acceptance reserved until terminal confirmation', async () => {
    state.proxy.mockResolvedValueOnce(Response.json({ jobId: 'render-a' }, { status: 202 }));
    const response = await renderPost(
      new NextRequest('https://edu.example/api/export-video/render', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=abc' },
        body: '--abc--',
      }),
    );
    expect(response.status).toBe(202);
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(state.settle).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });
});
describe('fee-bearing route inventory', () => {
  const routes = [
    'quiz-grade',
    'chat',
    'extract-document',
    'verify-model',
    'chat/pi',
    'verify-image-provider',
    'provider/probe-models',
    'generate/scene-actions',
    'verify-pdf-provider',
    'generate/video',
    'generate/scene-outlines-stream',
    'parse-pdf',
    'generate/agent-profiles',
    'transcription',
    'generate/image',
    'web-search',
    'generate/tts',
    'verify-video-provider',
    'generate/scene-content',
    'generate/voice',
    'pbl/v2/open-task',
    'pbl/v2/instructor',
    'pbl/v2/simulator',
    'pbl/v2/evaluate',
    'pbl/v2/task/update',
  ];
  it.each(routes)('%s rejects anonymous requests at the account boundary', async (route) => {
    state.user = null;
    const response = await middleware(
      new NextRequest(`https://edu.example/api/${route}`, { method: 'POST' }),
    );
    expect(response.status).toBe(401);
  });
  it.each(routes)('%s delegates its public POST to the billing gate', (route) => {
    const source = readFileSync(resolve(`app/api/${route}/route.ts`), 'utf8');
    expect(source).toMatch(/export async function POST[\s\S]*?return withBillableRequest\(req,/);
  });
});
