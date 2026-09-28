import Dexie from 'dexie';
import type { AudioFileRecord } from '@/lib/utils/database';

export const LEGACY_NARRATION_DATABASE = 'MAIC-Database';

/** Read a pre-account clip only when both its course and recorded text match. */
export async function readLegacyNarration(
  stageId: string,
  audioId: string,
  text: string,
): Promise<AudioFileRecord | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!(await Dexie.exists(LEGACY_NARRATION_DATABASE))) return undefined;
  const legacy = new Dexie(LEGACY_NARRATION_DATABASE);
  try {
    await legacy.open();
    if (!legacy.tables.some((table) => table.name === 'audioFiles')) return undefined;
    const row = await legacy.table<AudioFileRecord, string>('audioFiles').get(audioId);
    if (row?.stageId !== stageId || !row.blob || row.blob.size === 0) return undefined;
    if (!row.text?.trim() || row.text.trim() !== text.trim()) return undefined;
    return row;
  } finally {
    legacy.close();
  }
}
