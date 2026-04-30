// Contestant room-token verification (§8.2).

import bcrypt from 'bcrypt';

export const CONTESTANT_ID_REGEX = /^[a-z0-9._-]{1,32}$/;
export const ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const ROOM_TOKEN_BCRYPT_COST = 12;

/**
 * Hash a freshly-generated room token for storage. Cost factor 12 per §11.1.
 */
export async function hashRoomToken(token: string): Promise<string> {
  return bcrypt.hash(token, ROOM_TOKEN_BCRYPT_COST);
}

/**
 * Constant-time compare of a presented token against a stored bcrypt hash.
 * Returns true on match, false otherwise. Never throws on a bad hash —
 * returns false and lets the caller reject the upgrade.
 */
export async function verifyRoomTokenHash(
  presentedToken: string,
  storedHash: string,
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(presentedToken, storedHash);
  } catch {
    return false;
  }
}
