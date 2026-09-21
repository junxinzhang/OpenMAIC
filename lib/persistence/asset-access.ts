import type { Queryable } from '@openmaic/storage/document/pg';

/** Resolve the stored partition only after checking the caller's access. */
export async function authorizedAssetPrincipal(
  db: Queryable,
  assetId: string,
  ownerId: string,
): Promise<string | null> {
  const result = await db.query<{ principal: string } & Record<string, unknown>>(
    `SELECT a.principal FROM asset_entries a WHERE a.id = $1 AND (
      a.principal = $2 OR EXISTS (
        SELECT 1 FROM document_asset_refs r JOIN stage_meta s ON s.stage_id = r.stage_id
        WHERE r.asset_id = a.id AND s.deleted_at IS NULL
          AND (s.owner_id = $2 OR s.is_public = true)
      ) OR (a.principal = 'shared' AND EXISTS (
        SELECT 1 FROM stage_meta s WHERE s.stage_id = a.meta->>'stageId'
          AND s.owner_id = $2 AND s.deleted_at IS NULL
      ))
    ) LIMIT 1`,
    [assetId, ownerId],
  );
  return result.rows[0]?.principal ?? null;
}
