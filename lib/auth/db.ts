import { Pool } from 'pg';
const state = globalThis as typeof globalThis & {
  eduAccountPool?: Pool;
  eduAuthSchema?: Promise<void>;
};
export function getAccountPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return (state.eduAccountPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  }));
}
export async function ensureAuthSchema(): Promise<void> {
  if (!state.eduAuthSchema)
    state.eduAuthSchema = getAccountPool()
      .query(
        `
    CREATE TABLE IF NOT EXISTS edu_users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS edu_auth_accounts (provider text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES edu_users(id), PRIMARY KEY(provider, subject), UNIQUE(provider,user_id));
    CREATE TABLE IF NOT EXISTS edu_auth_sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES edu_users(id), expires_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS edu_auth_sessions_expiry ON edu_auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS edu_auth_challenges (id uuid PRIMARY KEY, email text NOT NULL, token_hash text NOT NULL UNIQUE, code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, used_at timestamptz);
    CREATE TABLE IF NOT EXISTS edu_auth_oauth (state_hash text PRIMARY KEY, browser_hash text NOT NULL, verifier text NOT NULL, nonce text NOT NULL, next_path text NOT NULL, link_user_id uuid REFERENCES edu_users(id), expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS edu_auth_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
  `,
      )
      .then(() => undefined)
      .catch((error) => {
        state.eduAuthSchema = undefined;
        throw error;
      });
  await state.eduAuthSchema;
}
