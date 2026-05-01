-- Replace the public-id + private-token pair on `rooms` with a single
-- `room_key`. The key is stored plaintext so admins can retrieve it
-- rather than having to re-rotate whenever they forget it. The only
-- secret gated by the key is "connect a contestant overlay to this
-- room" — a leak at worst lets someone trigger an extra help page,
-- which isn't worth the overhead of the public/private token scheme.

ALTER TABLE rooms ADD COLUMN room_key TEXT;

-- Backfill existing rooms with a fresh random key. Admins will need to
-- read the new key out of the DB (or rotate via the admin API) before
-- they can connect an overlay to a pre-migration room.
UPDATE rooms
   SET room_key = replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', '')
 WHERE room_key IS NULL;

ALTER TABLE rooms ALTER COLUMN room_key SET NOT NULL;
ALTER TABLE rooms ADD CONSTRAINT rooms_room_key_unique UNIQUE (room_key);

ALTER TABLE rooms DROP COLUMN token_hash;
