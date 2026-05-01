// Dev-only DB seed: creates a single, well-known room so a fresh
// `docker compose up` is immediately usable end-to-end (judge SPA via
// the seeded admin identity from `DEV_AUTH_BYPASS`, contestant overlay
// via the well-known room key below).
//
// IMPORTANT — never run in production. The `DEV_SEED_ROOM_KEY` is
// committed to the repo and printed in plain text on stdout; anyone
// who can reach the server's `/contestant?key=…` endpoint with this
// value would be able to connect as a contestant. The script
// hard-refuses to run when `NODE_ENV=production`. The compose file
// passes `NODE_ENV=development`, so the guard simply prevents the
// script from being invoked accidentally against a real deployment.
//
// Idempotent: re-running upserts the room row so the stored key always
// matches `DEV_SEED_ROOM_KEY` even after a developer manually rotated
// it via the admin API.

import { closePool, getPool } from './pool.js';

/** §3 well-known room id used by the dev seed. */
export const DEV_SEED_ROOM_ID = 'dev';

/** §9.2 well-known display label shown in the SPA's room picker. */
export const DEV_SEED_ROOM_LABEL = 'Dev Room';

/**
 * Plain-text room key for the dev room. NOT a secret — it is part of
 * the local-dev contract and is printed in `README.md`. The desktop
 * overlay launches against this with `--room-key dev-room-key-0123456789`.
 * The padding keeps the key inside `ROOM_KEY_REGEX`'s 16-char lower
 * bound without needing to special-case the dev path.
 */
export const DEV_SEED_ROOM_KEY = 'dev-room-key-0123456789';

export async function seedDevRoom(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-dev refuses to run with NODE_ENV=production');
  }
  const pool = getPool();
  await pool.query(
    `INSERT INTO rooms (id, display_label, room_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET display_label = EXCLUDED.display_label,
           room_key      = EXCLUDED.room_key,
           archived_at   = NULL`,
    [DEV_SEED_ROOM_ID, DEV_SEED_ROOM_LABEL, DEV_SEED_ROOM_KEY],
  );
}

async function main() {
  try {
    await seedDevRoom();
    console.log(
      `seeded dev room: id=${DEV_SEED_ROOM_ID} label="${DEV_SEED_ROOM_LABEL}" key=${DEV_SEED_ROOM_KEY}`,
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
