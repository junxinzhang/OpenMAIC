import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuditDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const TABLES = [
  ['stage_meta', 'owner_id', 'is_public'],
  ['document_stages', 'owner_id', null],
  ['agent_sessions', 'owner_id', null],
  ['owner_material', 'owner_id', null],
  ['asset_entries', 'principal', null],
  ['edu_render_jobs', 'user_id', null],
] as const;

/** Caller opens a read-only transaction; only aggregate counts leave this function. */
export async function auditDatabaseOwnership(db: AuditDb) {
  const result: Record<string, unknown> = {};
  for (const [table, owner, visibility] of TABLES) {
    const columns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',
      [table],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    if (!names.size) {
      result[table] = { present: false };
      continue;
    }
    const ownerPresent = names.has(owner);
    const queries = ['count(*)::int AS total'];
    if (ownerPresent)
      queries.push(
        `count(*) FILTER (WHERE "${owner}" IS NULL OR "${owner}"::text='')::int AS ownerless`,
        `count(*) FILTER (WHERE "${owner}"::text LIKE 'anon:%')::int AS anonymous`,
        `count(*) FILTER (WHERE "${owner}"::text='shared')::int AS shared`,
        `count(*) FILTER (WHERE "${owner}"::text LIKE 'user:%')::int AS account_owned`,
      );
    if (visibility && names.has(visibility))
      queries.push(
        `count(*) FILTER (WHERE "${visibility}" IS TRUE)::int AS public`,
        `count(*) FILTER (WHERE "${visibility}" IS NOT TRUE)::int AS private`,
      );
    result[table] = {
      present: true,
      ownerColumnPresent: ownerPresent,
      ...(await db.query(`SELECT ${queries.join(',')} FROM "${table}"`)).rows[0],
    };
  }
  return result;
}

/** Legacy JSON is inspected, never rewritten, and no content or owner ids are emitted. */
export async function auditFileOwnership(directory: string) {
  const counts = {
    present: true,
    total: 0,
    ownerless: 0,
    accountOwned: 0,
    anonymous: 0,
    public: 0,
    private: 0,
    invalid: 0,
    skipped: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  };
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...counts, present: false };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) {
      counts.skipped++;
      continue;
    }
    counts.total++;
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        counts.invalid++;
        continue;
      }
      if (typeof data.ownerId !== 'string' || !data.ownerId) counts.ownerless++;
      else if (data.ownerId.startsWith('anon:')) counts.anonymous++;
      else counts.accountOwned++;
      if (data.published === true || data.isPublic === true) counts.public++;
      else counts.private++;
      if (['queued', 'running', 'succeeded', 'failed'].includes(data.status))
        counts[data.status as 'queued' | 'running' | 'succeeded' | 'failed']++;
    } catch {
      counts.invalid++;
    }
  }
  return counts;
}
