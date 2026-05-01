// Shared regex validators for the contestant and room identifier
// character sets (§3.1, §4.1).

export const CONTESTANT_ID_REGEX = /^[a-z0-9._-]{1,32}$/;
export const ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Room keys are high-entropy random strings (see
 * `newRoomKey` in `routes/admin.ts`). We accept any URL-safe base64
 * payload within a sane length window so we don't reject pre-existing
 * keys produced by the migration's `gen_random_uuid()` concatenation
 * either. The upper bound exists only to keep a malicious client from
 * forcing a gigantic DB lookup via the `/contestant?key=…` query.
 */
export const ROOM_KEY_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
