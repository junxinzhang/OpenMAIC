import { getAccountPool, ensureAuthSchema } from './db';
import { digest } from './session';
import { AuthError } from './http';
export async function consumeLimit(key: string, maximum: number, seconds: number): Promise<void> {
  await ensureAuthSchema();
  const result = await getAccountPool().query<{ count: number }>(
    `INSERT INTO edu_auth_limits(key,window_start,count) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN edu_auth_limits.window_start < now()-($2*interval '1 second') THEN 1 ELSE edu_auth_limits.count+1 END,
    window_start=CASE WHEN edu_auth_limits.window_start < now()-($2*interval '1 second') THEN now() ELSE edu_auth_limits.window_start END RETURNING count`,
    [digest(key), seconds],
  );
  if (result.rows[0].count > maximum) throw new AuthError(429, '尝试过于频繁，请稍后重试。');
}
