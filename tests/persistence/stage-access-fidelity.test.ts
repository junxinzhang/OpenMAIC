import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { StageAccessError } from '@/lib/persistence/stage-meta';
const authUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getRequestUser: authUser }));

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

function courseDocument(id: string, name = 'Agent course') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function ownerStore(pool: PGlitePool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

/** A single row read back from stage_meta after a delete. */
interface StageMetaTombstoneRow {
  deleted_at: string | Date | null;
}

describe('reference-fidelity stage access', () => {
  let pool: PGlitePool;
  const ownerCookie = '11111111-1111-4111-8111-111111111111';
  const visitorCookie = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://stage-access-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('disables browser and CDN caching on actual account asset and document responses', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    authUser.mockResolvedValue({ id: 'one' });
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(
      process.env.DATABASE_URL!,
      () => pool as never,
    );
    const assetId = await provider.assetStore.put(
      { key: 'user:one' },
      new Blob(['private-image'], { type: 'image/png' }),
      { contentType: 'image/png' },
    );
    await ownerStore(pool, 'user:one').saveDocument(courseDocument('private-cache-course'));
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const asset = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`),
      { poolFactory: () => pool as never },
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('private-image');
    expect(asset.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(asset.headers.get('cdn-cache-control')).toContain('no-store');
    const document = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/private-cache-course'),
      { poolFactory: () => pool as never },
    );
    expect(document.status).toBe(200);
    expect(document.headers.get('cache-control')).toContain('no-store');
    authUser.mockResolvedValue({ id: 'two' });
    const denied = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`),
      { poolFactory: () => pool as never },
    );
    expect(denied.status).not.toBe(200);
    expect(denied.headers.get('cache-control')).toContain('no-store');
    expect(await denied.text()).not.toContain('private-image');
  });

  it('keeps unclaimed shared assets private and rejects foreign asset grafting', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const { authorizedAssetPrincipal } = await import('@/lib/persistence/asset-access');
    const provider = await getServerPersistenceProvider(
      process.env.DATABASE_URL!,
      () => pool as never,
    );
    const assetId = await provider.assetStore.put({ key: 'user:one' }, new Blob(['private']), {
      contentType: 'text/plain',
    });
    const oldAssetId = await provider.assetStore.put({ key: 'shared' }, new Blob(['legacy']), {
      contentType: 'text/plain',
    });
    const course = courseDocument('foreign-asset-course');
    const scene = {
      id: 'scene-1',
      stageId: course.stage.id,
      order: 1,
      title: 'Image',
      type: 'slide',
      createdAt: 1800000000000,
      updatedAt: 1800000000000,
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas-1',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          theme: {
            backgroundColor: '#fff',
            themeColors: ['#2563eb'],
            fontColor: '#111',
            fontName: 'Inter',
          },
          elements: [
            {
              id: 'image-1',
              type: 'image',
              src: assetId,
              left: 0,
              top: 0,
              width: 100,
              height: 100,
            },
          ],
        },
      },
    };
    await expect(
      ownerStore(pool, 'user:two').saveDocument({ ...course, scenes: [scene] } as never),
    ).rejects.toThrow(StageAccessError);
    expect(await ownerStore(pool, 'user:two').loadDocument(course.stage.id)).toBeNull();
    expect(await authorizedAssetPrincipal(pool as never, assetId, 'user:one')).toBe('user:one');
    expect(await authorizedAssetPrincipal(pool as never, assetId, 'user:two')).toBeNull();
    expect(await authorizedAssetPrincipal(pool as never, oldAssetId, 'user:two')).toBeNull();
    expect(await authorizedAssetPrincipal(pool as never, oldAssetId, 'public:visitor')).toBeNull();
  });

  it('keeps private account courses isolated and allows explicitly published reads', async () => {
    vi.stubEnv('EDU_AUTH_ENABLED', 'true');
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const owner = ownerStore(pool, 'user:one');
    const visitor = ownerStore(pool, 'user:two');
    const publicVisitor = ownerStore(pool, 'public:visitor');
    await owner.saveDocument(courseDocument('private-course'));
    expect(await visitor.loadDocument('private-course')).toBeNull();
    expect(await publicVisitor.loadDocument('private-course')).toBeNull();
    expect(await owner.loadDocument('private-course')).not.toBeNull();
    await pool.query('UPDATE stage_meta SET is_public = true WHERE stage_id = $1', [
      'private-course',
    ]);
    expect(await visitor.loadDocument('private-course')).not.toBeNull();
    expect(await publicVisitor.loadDocument('private-course')).not.toBeNull();
    await expect(visitor.saveDocument(courseDocument('private-course', 'hijack'))).rejects.toThrow(
      StageAccessError,
    );
  });

  it('loads an agent-created stage through the browser path using the same owner cookie', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-agent-browser-regression';
    await ownerStore(pool, `anon:${ownerCookie}`).saveDocument(courseDocument(stageId));

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        headers: { cookie: `anonymous_id=${ownerCookie}` },
      }),
      { poolFactory: () => pool as never },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stage: { id: stageId } });
    expect(provider.pool).toBe(pool);
  });

  it('allows capability reads, refuses foreign writes, and filters the owner library', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-capability-policy';
    const owner = ownerStore(pool, `anon:${ownerCookie}`);
    const visitor = ownerStore(pool, `anon:${visitorCookie}`);
    await owner.saveDocument(courseDocument(stageId));

    await expect(visitor.loadDocument(stageId)).resolves.toMatchObject({ stage: { id: stageId } });
    await expect(
      visitor.saveDocument(courseDocument(stageId, 'Foreign edit')),
    ).rejects.toBeInstanceOf(StageAccessError);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const visitorRead = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        headers: { cookie: `anonymous_id=${visitorCookie}` },
      }),
      { poolFactory: () => pool as never },
    );
    expect(visitorRead.status).toBe(200);
    await expect(visitorRead.json()).resolves.toMatchObject({ stage: { id: stageId } });

    const foreignWrite = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        method: 'PUT',
        headers: {
          cookie: `anonymous_id=${visitorCookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(courseDocument(stageId, 'Foreign edit')),
      }),
      { poolFactory: () => pool as never },
    );
    expect(foreignWrite.status).toBe(403);
    await expect(foreignWrite.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_DOCUMENTS' },
    });

    const { GET: listStages } = await import('@/app/api/stages/route');
    const ownerList = await listStages(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ownerCookie}` },
      }),
    );
    const visitorList = await listStages(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${visitorCookie}` },
      }),
    );
    await expect(ownerList.json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: stageId })],
    });
    await expect(visitorList.json()).resolves.toEqual({ stages: [] });
  });

  it('tombstones deletions and permanently retires the stage id', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-retired-id';
    const owner = ownerStore(pool, `anon:${ownerCookie}`);
    await owner.saveDocument(courseDocument(stageId));
    await owner.deleteDocument(stageId);

    await expect(owner.loadDocument(stageId)).resolves.toBeNull();
    await expect(
      owner.saveDocument(courseDocument(stageId, 'Resurrection')),
    ).rejects.toBeInstanceOf(StageAccessError);
    const rows = await pool.query(
      `SELECT meta.deleted_at
         FROM stage_meta AS meta
         JOIN document_stages AS stages ON stages.id = meta.stage_id
        WHERE meta.stage_id = $1`,
      [stageId],
    );
    expect((rows.rows[0] as StageMetaTombstoneRow | undefined)?.deleted_at).not.toBeNull();
  });
});
