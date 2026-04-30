-- TCA Timer initial schema (§11.3).
-- Authoritative DDL mirrors src/db/schema.sql.

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY
                CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_label TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS station_assignments (
  room            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  contestant_id   TEXT NOT NULL
                  CHECK (contestant_id ~ '^[a-z0-9._-]{1,32}$'),
  station_number  INT NOT NULL,
  PRIMARY KEY (room, contestant_id)
);
CREATE INDEX IF NOT EXISTS station_assignments_room ON station_assignments(room);

CREATE TABLE IF NOT EXISTS timer_state (
  room              TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  version           BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('idle','running','paused')),
  ends_at_server_ms BIGINT,
  remaining_ms      BIGINT,
  message           TEXT NOT NULL DEFAULT '',
  set_by_sub        TEXT NOT NULL,
  set_by_email      TEXT NOT NULL,
  set_at_server_ms  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_prefs (
  sub                       TEXT PRIMARY KEY,
  last_seen_email           TEXT NOT NULL,
  phone_e164                TEXT,
  phone_status              TEXT NOT NULL DEFAULT 'none'
                            CHECK (phone_status IN ('none','pending','verified','opted_out')),
  pending_phone_code_hash   TEXT,
  pending_phone_expires_at  TIMESTAMPTZ,
  email_address             TEXT,
  email_status              TEXT NOT NULL DEFAULT 'none'
                            CHECK (email_status IN ('none','pending','verified','opted_out')),
  pending_email_code_hash   TEXT,
  pending_email_expires_at  TIMESTAMPTZ,
  enabled_rooms             TEXT[] NOT NULL DEFAULT '{}',
  quiet_hours_start         TIME,
  quiet_hours_end           TIME,
  quiet_hours_weekdays      SMALLINT NOT NULL DEFAULT 0
                            CHECK (quiet_hours_weekdays BETWEEN 0 AND 127),
  timezone                  TEXT NOT NULL DEFAULT 'UTC',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  room          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  at_server_ms  BIGINT NOT NULL,
  actor_sub     TEXT NOT NULL,
  actor_email   TEXT,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_log_room_at ON audit_log(room, at_server_ms DESC);
CREATE INDEX IF NOT EXISTS audit_log_at      ON audit_log(at_server_ms DESC);
