// Dev-only DB seed: creates a single, well-known room so a fresh
// `docker compose up` is immediately usable end-to-end (judge SPA via
// the seeded admin identity from `DEV_AUTH_BYPASS`, contestant overlay
// via the well-known room token below).
//
// IMPORTANT — never run in production. The `DEV_SEED_ROOM_TOKEN` is
// committed to the repo and printed in plain text on stdout; anyone
// who can reach the server's `/contestant?token=…` endpoint with this
// value would be able to connect as a contestant. The script
// hard-refuses to run when `NODE_ENV=production`. The compose file
// passes `NODE_ENV=development`, so the guard simply prevents the
// script from being invoked accidentally against a real deployment.
//
// Idempotent: re-running upserts the room row so the token hash always
// matches `DEV_SEED_ROOM_TOKEN` even after a developer manually rotated
// the password via the admin API.

import bcrypt from 'bcrypt';

import { hashRoomToken } from '../auth/room-token.js';
import { closePool, getPool } from './pool.js';

/** §3 well-known room id used by the dev seed. */
export const DEV_SEED_ROOM_ID = 'dev';

/** §9.2 well-known display label shown in the SPA's room picker. */
export const DEV_SEED_ROOM_LABEL = 'Dev Room';

/**
 * Plain-text room token for the dev room. NOT a secret — it is part of
 * the local-dev contract and is printed in `README.md`. The desktop
 * overlay launches against this with `--room dev --room-token
 * dev-room-token`.
 */
export const DEV_SEED_ROOM_TOKEN = 'dev-room-token';

export async function seedDevRoom(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-dev refuses to run with NODE_ENV=production');
  }
  const pool = getPool();
  const existing = await pool.query<{ token_hash: string }>(
    `SELECT token_hash FROM rooms WHERE id = $1`,
    [DEV_SEED_ROOM_ID],
  );

  let tokenHash: string;
  if (existing.rowCount && existing.rowCount > 0) {
    // Reuse the stored hash if it already matches the well-known
    // token — bcrypt hashes embed a random salt, so re-hashing on
    // every boot would invalidate the well-known token even though
    // it's still the right one.
    const stored = existing.rows[0]!.token_hash;
    const matches = await bcrypt.compare(DEV_SEED_ROOM_TOKEN, stored);
    tokenHash = matches ? stored : await hashRoomToken(DEV_SEED_ROOM_TOKEN);
  } else {
    tokenHash = await hashRoomToken(DEV_SEED_ROOM_TOKEN);
  }

  await pool.query(
    `INSERT INTO rooms (id, display_label, token_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET display_label = EXCLUDED.display_label,
           token_hash    = EXCLUDED.token_hash,
           archived_at   = NULL`,
    [DEV_SEED_ROOM_ID, DEV_SEED_ROOM_LABEL, tokenHash],
  );
}

async function main() {
  try {
    await seedDevRoom();
    console.log(
      `seeded dev room: id=${DEV_SEED_ROOM_ID} label="${DEV_SEED_ROOM_LABEL}" token=${DEV_SEED_ROOM_TOKEN}`,
    );
  } catch (err) {
    console.error('dev seed failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  void main();
}
