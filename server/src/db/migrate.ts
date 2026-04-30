// Minimal SQL migration runner: reads .sql files from ./migrations/ in
// lexicographical order and applies any that haven't been recorded in the
// `_migrations` table yet. No rollback. Used via `npm run migrate`.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool, closePool } from './pool.js';

export async function runMigrations(
  migrationsDir: string = join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const res = await pool.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name = $1`,
      [file],
    );
    if (res.rowCount && res.rowCount > 0) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

async function main() {
  try {
    const { applied, skipped } = await runMigrations();
    console.log(`applied: ${applied.join(', ') || '(none)'}`);
    console.log(`skipped: ${skipped.join(', ') || '(none)'}`);
  } catch (err) {
    console.error('migration failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  void main();
}
