-- TCA Timer Postgres schema (§11.3). Authoritative DDL.

-- Rooms registry. The token is never stored in plaintext.
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY
                CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_label TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                  -- bcrypt hash, cost 12
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

-- Station assignments: maps contestant IDs to physical station numbers per room.
CREATE TABLE station_assignments (
  room            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  contestant_id   TEXT NOT NULL
                  CHECK (contestant_id ~ '^[a-z0-9._-]{1,32}$'),
  station_number  INT NOT NULL,
  PRIMARY KEY (room, contestant_id)
);
CREATE INDEX station_assignments_room ON station_assignments(room);

-- Current timer state, one row per room. Used to recover after restart.
CREATE TABLE timer_state (
  room              TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  version           BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('idle','running','paused')),
  ends_at_server_ms BIGINT,                     -- non-null iff running
  remaining_ms      BIGINT,                     -- non-null iff paused
  message           TEXT NOT NULL DEFAULT '',
  set_by_sub        TEXT NOT NULL,              -- judge JWT sub
  set_by_email      TEXT NOT NULL,              -- snapshot at write time
  set_at_server_ms  BIGINT NOT NULL
);

-- Per-judge notification preferences. Keyed on JWT sub, NEVER on email.
CREATE TABLE judge_prefs (
  sub                       TEXT PRIMARY KEY,
  last_seen_email           TEXT NOT NULL,
  -- SMS
  phone_e164                TEXT,
  phone_status              TEXT NOT NULL DEFAULT 'none'
                            CHECK (phone_status IN ('none','pending','verified','opted_out')),
  pending_phone_code_hash   TEXT,
  pending_phone_expires_at  TIMESTAMPTZ,
  -- Email
  email_address             TEXT,
  email_status              TEXT NOT NULL DEFAULT 'none'
                            CHECK (email_status IN ('none','pending','verified','opted_out')),
  pending_email_code_hash   TEXT,
  pending_email_expires_at  TIMESTAMPTZ,
  -- Common
  enabled_rooms             TEXT[] NOT NULL DEFAULT '{}',
  quiet_hours_start         TIME,
  quiet_hours_end           TIME,
  quiet_hours_weekdays      SMALLINT NOT NULL DEFAULT 0
                            CHECK (quiet_hours_weekdays BETWEEN 0 AND 127),
  timezone                  TEXT NOT NULL DEFAULT 'UTC',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit log. Retained 90 days then auto-pruned.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  room          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  at_server_ms  BIGINT NOT NULL,
  actor_sub     TEXT NOT NULL,                 -- 'system' for non-user events
  actor_email   TEXT,                          -- snapshot for human readability
  event_type    TEXT NOT NULL,                 -- see §11.4
  payload       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_log_room_at ON audit_log(room, at_server_ms DESC);
CREATE INDEX audit_log_at      ON audit_log(at_server_ms DESC);
