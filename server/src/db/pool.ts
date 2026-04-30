// Postgres connection pool (§11.1). Singleton with lazy init so tests that
// don't need a database can still run.

import pg from 'pg';

let pool: pg.Pool | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function pingDb(): Promise<'ok' | 'degraded' | 'unknown'> {
  if (!hasDatabase()) return 'unknown';
  try {
    const p = getPool();
    const res = await p.query('SELECT 1 AS ok');
    return res.rows[0]?.ok === 1 ? 'ok' : 'degraded';
  } catch {
    return 'degraded';
  }
}
