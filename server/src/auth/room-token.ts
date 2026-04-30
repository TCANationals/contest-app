// Contestant room-token verification (§8.2).
//
// TODO: bcrypt compare (cost 12) against `rooms.token_hash`. Constant-time.

export async function verifyRoomToken(
  _roomId: string,
  _presentedToken: string,
): Promise<boolean> {
  throw new Error('verifyRoomToken: not implemented');
}

export const CONTESTANT_ID_REGEX = /^[a-z0-9._-]{1,32}$/;
export const ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;
