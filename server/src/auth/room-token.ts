export async function verifyRoomToken(_roomId: string, _token: string): Promise<boolean> {
  // TODO(spec §8.2): compare candidate token to bcrypt hash in rooms.token_hash.
  return false;
}
