import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LEGACY_NARRATION_DATABASE, readLegacyNarration } from '@/lib/audio/legacy-narration-cache';

beforeEach(async () => {
  await Dexie.delete(LEGACY_NARRATION_DATABASE);
  const db = new Dexie(LEGACY_NARRATION_DATABASE);
  db.version(1).stores({ audioFiles: 'id' });
  await db.open();
  await db
    .table('audioFiles')
    .put({
      id: 'old-clip',
      stageId: 'owned-course',
      text: 'Original narration',
      blob: new Blob(['audio']),
      format: 'wav',
      createdAt: 1,
    });
  db.close();
});
afterEach(async () => {
  await Dexie.delete(LEGACY_NARRATION_DATABASE);
});
it('recovers the existing bytes without deleting the legacy copy', async () => {
  const row = await readLegacyNarration('owned-course', 'old-clip', 'Original narration');
  expect(row?.blob.size).toBe(5);
  expect(await readLegacyNarration('owned-course', 'old-clip', 'Original narration')).toBeDefined();
});
it('does not recover another course or outdated narration', async () => {
  expect(
    await readLegacyNarration('another-course', 'old-clip', 'Original narration'),
  ).toBeUndefined();
  expect(
    await readLegacyNarration('owned-course', 'old-clip', 'Changed narration'),
  ).toBeUndefined();
});
