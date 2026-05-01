// Data-access layer for the TCA Timer backend. Thin wrappers around `pg`
// queries that keep all SQL in one place.

import { getPool, hasDatabase } from './pool.js';
import type { HelpQueue } from '../help-queue.js';
import type { TimerState } from '../timer.js';

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomRow {
  id: string;
  display_label: string;
  room_key: string;
  created_at: Date;
  archived_at: Date | null;
}

async function _insertRoom(id: string, displayLabel: string, roomKey: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO rooms (id, display_label, room_key)
     VALUES ($1, $2, $3)`,
    [id, displayLabel, roomKey],
  );
}

async function _updateRoomKey(id: string, roomKey: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE rooms SET room_key = $2 WHERE id = $1`, [id, roomKey]);
}

async function _getRoom(id: string): Promise<RoomRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<RoomRow>(
    `SELECT id, display_label, room_key, created_at, archived_at
       FROM rooms WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function _getRoomByKey(roomKey: string): Promise<RoomRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<RoomRow>(
    `SELECT id, display_label, room_key, created_at, archived_at
       FROM rooms WHERE room_key = $1`,
    [roomKey],
  );
  return res.rows[0] ?? null;
}

async function _listActiveRooms(): Promise<RoomRow[]> {
  if (!hasDatabase()) return [];
  const pool = getPool();
  const res = await pool.query<RoomRow>(
    `SELECT id, display_label, room_key, created_at, archived_at
       FROM rooms
       WHERE archived_at IS NULL
       ORDER BY id ASC`,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Station assignments
// ---------------------------------------------------------------------------

async function _getStationNumber(room: string, contestantId: string): Promise<number | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<{ station_number: number }>(
    `SELECT station_number FROM station_assignments
      WHERE room = $1 AND contestant_id = $2`,
    [room, contestantId],
  );
  return res.rows[0]?.station_number ?? null;
}

// ---------------------------------------------------------------------------
// Timer state
// ---------------------------------------------------------------------------

async function _upsertTimerState(state: TimerState): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO timer_state
       (room, version, status, ends_at_server_ms, remaining_ms, message,
        set_by_sub, set_by_email, set_at_server_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (room) DO UPDATE SET
       version           = EXCLUDED.version,
       status            = EXCLUDED.status,
       ends_at_server_ms = EXCLUDED.ends_at_server_ms,
       remaining_ms      = EXCLUDED.remaining_ms,
       message           = EXCLUDED.message,
       set_by_sub        = EXCLUDED.set_by_sub,
       set_by_email      = EXCLUDED.set_by_email,
       set_at_server_ms  = EXCLUDED.set_at_server_ms`,
    [
      state.room,
      state.version,
      state.status,
      state.endsAtServerMs,
      state.remainingMs,
      state.message,
      state.setBySub,
      state.setByEmail,
      state.setAtServerMs,
    ],
  );
}

async function _loadTimerState(room: string): Promise<TimerState | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query(
    `SELECT room, version, status, ends_at_server_ms, remaining_ms, message,
            set_by_sub, set_by_email, set_at_server_ms
       FROM timer_state WHERE room = $1`,
    [room],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    room: r.room,
    version: Number(r.version),
    status: r.status,
    endsAtServerMs: r.ends_at_server_ms == null ? null : Number(r.ends_at_server_ms),
    remainingMs: r.remaining_ms == null ? null : Number(r.remaining_ms),
    message: r.message,
    setBySub: r.set_by_sub,
    setByEmail: r.set_by_email,
    setAtServerMs: Number(r.set_at_server_ms),
  };
}

// Help queue is not persisted (authoritative is in-memory).
type _HelpQueueTypeReference = HelpQueue;
void (null as unknown as _HelpQueueTypeReference);

// ---------------------------------------------------------------------------
// Judge preferences
// ---------------------------------------------------------------------------

export interface JudgePrefsRow {
  sub: string;
  last_seen_email: string;
  phone_e164: string | null;
  phone_status: 'none' | 'pending' | 'verified' | 'opted_out';
  pending_phone_code_hash: string | null;
  pending_phone_expires_at: Date | null;
  email_address: string | null;
  email_status: 'none' | 'pending' | 'verified' | 'opted_out';
  pending_email_code_hash: string | null;
  pending_email_expires_at: Date | null;
  enabled_rooms: string[];
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_weekdays: number;
  timezone: string;
  updated_at: Date;
}

async function _getJudgePrefs(sub: string): Promise<JudgePrefsRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<JudgePrefsRow>(`SELECT * FROM judge_prefs WHERE sub = $1`, [sub]);
  return res.rows[0] ?? null;
}

/**
 * Partial-update shape for `_upsertJudgePrefs`. Every field other than
 * `sub` and `lastSeenEmail` is optional and `undefined` means "leave the
 * existing value alone". `null` is a real, distinct value (e.g., clearing
 * a phone number). This disambiguates partial vs full updates, which the
 * previous `COALESCE`-everywhere approach silently conflated.
 */
export interface JudgePrefsPatch {
  sub: string;
  lastSeenEmail: string;
  phoneE164?: string | null;
  phoneStatus?: JudgePrefsRow['phone_status'];
  pendingPhoneCodeHash?: string | null;
  pendingPhoneExpiresAt?: Date | null;
  emailAddress?: string | null;
  emailStatus?: JudgePrefsRow['email_status'];
  pendingEmailCodeHash?: string | null;
  pendingEmailExpiresAt?: Date | null;
  enabledRooms?: string[];
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  quietHoursWeekdays?: number;
  timezone?: string;
}

async function _upsertJudgePrefs(row: JudgePrefsPatch): Promise<void> {
  const pool = getPool();

  // Fixed positional placeholders for the VALUES list. The DO UPDATE SET
  // clause reuses these same placeholders — PostgreSQL permits the same
  // $N to appear multiple times in one statement — so no extra parameters
  // are needed, and a field that was not supplied on the patch is simply
  // omitted from the SET clause (preserving its existing value).
  const sets: string[] = ['last_seen_email = $2', 'updated_at = now()'];
  if (row.phoneE164 !== undefined) sets.push('phone_e164 = $3');
  if (row.phoneStatus !== undefined) sets.push('phone_status = $4');
  if (row.pendingPhoneCodeHash !== undefined) sets.push('pending_phone_code_hash = $5');
  if (row.pendingPhoneExpiresAt !== undefined) sets.push('pending_phone_expires_at = $6');
  if (row.emailAddress !== undefined) sets.push('email_address = $7');
  if (row.emailStatus !== undefined) sets.push('email_status = $8');
  if (row.pendingEmailCodeHash !== undefined) sets.push('pending_email_code_hash = $9');
  if (row.pendingEmailExpiresAt !== undefined) sets.push('pending_email_expires_at = $10');
  if (row.enabledRooms !== undefined) sets.push('enabled_rooms = $11');
  if (row.quietHoursStart !== undefined) sets.push('quiet_hours_start = $12');
  if (row.quietHoursEnd !== undefined) sets.push('quiet_hours_end = $13');
  if (row.quietHoursWeekdays !== undefined) sets.push('quiet_hours_weekdays = $14');
  if (row.timezone !== undefined) sets.push('timezone = $15');

  await pool.query(
    `INSERT INTO judge_prefs (
        sub, last_seen_email,
        phone_e164, phone_status, pending_phone_code_hash, pending_phone_expires_at,
        email_address, email_status, pending_email_code_hash, pending_email_expires_at,
        enabled_rooms, quiet_hours_start, quiet_hours_end, quiet_hours_weekdays, timezone,
        updated_at)
      VALUES ($1, $2,
              $3, COALESCE($4,'none'), $5, $6,
              $7, COALESCE($8,'none'), $9, $10,
              COALESCE($11,'{}'::text[]), $12, $13, COALESCE($14,0), COALESCE($15,'UTC'),
              now())
      ON CONFLICT (sub) DO UPDATE SET ${sets.join(', ')}`,
    [
      row.sub,
      row.lastSeenEmail,
      row.phoneE164 ?? null,
      row.phoneStatus ?? null,
      row.pendingPhoneCodeHash ?? null,
      row.pendingPhoneExpiresAt ?? null,
      row.emailAddress ?? null,
      row.emailStatus ?? null,
      row.pendingEmailCodeHash ?? null,
      row.pendingEmailExpiresAt ?? null,
      row.enabledRooms ?? null,
      row.quietHoursStart ?? null,
      row.quietHoursEnd ?? null,
      row.quietHoursWeekdays ?? null,
      row.timezone ?? null,
    ],
  );
}

async function _setPhoneStatus(sub: string, status: JudgePrefsRow['phone_status']): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE judge_prefs
        SET phone_status = $2,
            pending_phone_code_hash = NULL,
            pending_phone_expires_at = NULL,
            updated_at = now()
      WHERE sub = $1`,
    [sub, status],
  );
}

async function _setEmailStatus(sub: string, status: JudgePrefsRow['email_status']): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE judge_prefs
        SET email_status = $2,
            pending_email_code_hash = NULL,
            pending_email_expires_at = NULL,
            updated_at = now()
      WHERE sub = $1`,
    [sub, status],
  );
}

async function _findJudgesForRoom(room: string): Promise<JudgePrefsRow[]> {
  if (!hasDatabase()) return [];
  const pool = getPool();
  const res = await pool.query<JudgePrefsRow>(
    `SELECT * FROM judge_prefs
       WHERE $1 = ANY(enabled_rooms)
         AND (   phone_status = 'verified'
              OR email_status = 'verified')`,
    [room],
  );
  return res.rows;
}

async function _findJudgeByPhone(phoneE164: string): Promise<JudgePrefsRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<JudgePrefsRow>(
    `SELECT * FROM judge_prefs WHERE phone_e164 = $1 LIMIT 1`,
    [phoneE164],
  );
  return res.rows[0] ?? null;
}

async function _findJudgeByEmail(email: string): Promise<JudgePrefsRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<JudgePrefsRow>(
    `SELECT * FROM judge_prefs WHERE email_address = $1 LIMIT 1`,
    [email],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEvent {
  /**
   * `audit_log.id` (BIGSERIAL). Populated for rows returned by
   * `queryAuditLog`. Optional because callers writing a new event via
   * `insertAuditEvent` don't supply it — the column defaults to the
   * sequence.
   */
  id?: number;
  room: string;
  atServerMs: number;
  actorSub: string;
  actorEmail: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

async function _insertAuditEvent(ev: AuditEvent): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_log (room, at_server_ms, actor_sub, actor_email, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      ev.room,
      ev.atServerMs,
      ev.actorSub,
      ev.actorEmail,
      ev.eventType,
      JSON.stringify(ev.payload ?? {}),
    ],
  );
}

export interface AuditLogFilter {
  room?: string;
  since?: number;
  limit?: number;
}

async function _queryAuditLog(filter: AuditLogFilter): Promise<AuditEvent[]> {
  if (!hasDatabase()) return [];
  const pool = getPool();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.room) {
    params.push(filter.room);
    clauses.push(`room = $${params.length}`);
  }
  if (filter.since != null) {
    params.push(filter.since);
    clauses.push(`at_server_ms >= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(filter.limit ?? 1000, 10_000));
  const limitPlaceholder = `$${params.length}`;
  const res = await pool.query(
    `SELECT id, room, at_server_ms, actor_sub, actor_email, event_type, payload
       FROM audit_log
       ${where}
       ORDER BY at_server_ms DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return res.rows.map((r: {
    id: string | number;
    room: string;
    at_server_ms: string | number;
    actor_sub: string;
    actor_email: string | null;
    event_type: string;
    payload: unknown;
  }) => ({
    // BIGSERIAL comes back as a string from `pg` by default; coerce to
    // number for JSON-friendly output (audit ids fit in a JS number
    // for any reasonable retention window).
    id: Number(r.id),
    room: r.room,
    atServerMs: Number(r.at_server_ms),
    actorSub: r.actor_sub,
    actorEmail: r.actor_email,
    eventType: r.event_type,
    // The column is `JSONB NOT NULL DEFAULT '{}'` and we always insert
    // an object via `insertAuditEvent`, so this assertion is safe.
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

async function _pruneAuditLog(olderThanMs: number): Promise<number> {
  if (!hasDatabase()) return 0;
  const pool = getPool();
  const res = await pool.query(`DELETE FROM audit_log WHERE at_server_ms < $1`, [olderThanMs]);
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Test-only override hook. Production code never sets this. Tests may
// replace DAL functions piecemeal without fighting ESM's frozen exports.
// ---------------------------------------------------------------------------

export interface DalOverrides {
  getRoom?: (id: string) => Promise<RoomRow | null>;
  getRoomByKey?: (roomKey: string) => Promise<RoomRow | null>;
  listActiveRooms?: () => Promise<RoomRow[]>;
  getStationNumber?: (room: string, contestantId: string) => Promise<number | null>;
  loadTimerState?: (room: string) => Promise<TimerState | null>;
  upsertTimerState?: (state: TimerState) => Promise<void>;
  insertAuditEvent?: (ev: AuditEvent) => Promise<void>;
  findJudgesForRoom?: (room: string) => Promise<JudgePrefsRow[]>;
  findJudgeByPhone?: (phone: string) => Promise<JudgePrefsRow | null>;
  findJudgeByEmail?: (email: string) => Promise<JudgePrefsRow | null>;
  getJudgePrefs?: (sub: string) => Promise<JudgePrefsRow | null>;
  queryAuditLog?: (filter: AuditLogFilter) => Promise<AuditEvent[]>;
  pruneAuditLog?: (olderThanMs: number) => Promise<number>;
  setPhoneStatus?: (sub: string, status: JudgePrefsRow['phone_status']) => Promise<void>;
  setEmailStatus?: (sub: string, status: JudgePrefsRow['email_status']) => Promise<void>;
  upsertJudgePrefs?: (row: JudgePrefsPatch) => Promise<void>;
  insertRoom?: (id: string, displayLabel: string, roomKey: string) => Promise<void>;
  updateRoomKey?: (id: string, roomKey: string) => Promise<void>;
}

export const __testOverrides: DalOverrides = {};

// ---------------------------------------------------------------------------
// Public exports route through the override hook.
// ---------------------------------------------------------------------------

export function insertRoom(id: string, displayLabel: string, roomKey: string): Promise<void> {
  return (__testOverrides.insertRoom ?? _insertRoom)(id, displayLabel, roomKey);
}
export function updateRoomKey(id: string, roomKey: string): Promise<void> {
  return (__testOverrides.updateRoomKey ?? _updateRoomKey)(id, roomKey);
}
export function upsertJudgePrefs(row: JudgePrefsPatch): Promise<void> {
  return (__testOverrides.upsertJudgePrefs ?? _upsertJudgePrefs)(row);
}
export function setPhoneStatus(sub: string, status: JudgePrefsRow['phone_status']): Promise<void> {
  return (__testOverrides.setPhoneStatus ?? _setPhoneStatus)(sub, status);
}
export function setEmailStatus(sub: string, status: JudgePrefsRow['email_status']): Promise<void> {
  return (__testOverrides.setEmailStatus ?? _setEmailStatus)(sub, status);
}

export function getRoom(id: string): Promise<RoomRow | null> {
  return (__testOverrides.getRoom ?? _getRoom)(id);
}
export function getRoomByKey(roomKey: string): Promise<RoomRow | null> {
  return (__testOverrides.getRoomByKey ?? _getRoomByKey)(roomKey);
}
export function listActiveRooms(): Promise<RoomRow[]> {
  return (__testOverrides.listActiveRooms ?? _listActiveRooms)();
}
export function getStationNumber(room: string, contestantId: string): Promise<number | null> {
  return (__testOverrides.getStationNumber ?? _getStationNumber)(room, contestantId);
}
export function loadTimerState(room: string): Promise<TimerState | null> {
  return (__testOverrides.loadTimerState ?? _loadTimerState)(room);
}
export function upsertTimerState(state: TimerState): Promise<void> {
  return (__testOverrides.upsertTimerState ?? _upsertTimerState)(state);
}
export function insertAuditEvent(ev: AuditEvent): Promise<void> {
  return (__testOverrides.insertAuditEvent ?? _insertAuditEvent)(ev);
}
export function findJudgesForRoom(room: string): Promise<JudgePrefsRow[]> {
  return (__testOverrides.findJudgesForRoom ?? _findJudgesForRoom)(room);
}
export function findJudgeByPhone(phone: string): Promise<JudgePrefsRow | null> {
  return (__testOverrides.findJudgeByPhone ?? _findJudgeByPhone)(phone);
}
export function findJudgeByEmail(email: string): Promise<JudgePrefsRow | null> {
  return (__testOverrides.findJudgeByEmail ?? _findJudgeByEmail)(email);
}
export function getJudgePrefs(sub: string): Promise<JudgePrefsRow | null> {
  return (__testOverrides.getJudgePrefs ?? _getJudgePrefs)(sub);
}
export function queryAuditLog(filter: AuditLogFilter): Promise<AuditEvent[]> {
  return (__testOverrides.queryAuditLog ?? _queryAuditLog)(filter);
}
export function pruneAuditLog(olderThanMs: number): Promise<number> {
  return (__testOverrides.pruneAuditLog ?? _pruneAuditLog)(olderThanMs);
}

// ---------------------------------------------------------------------------
// Retry ring buffer (§11.5)
//
// Failed DB writes are parked here so the WebSocket broadcast path never
// stalls. A background drain (see `startRetryDrain`) attempts to re-run
// every pending job periodically. Persistently broken jobs (e.g., a FK
// violation because a room was deleted after the write was enqueued)
// MUST NOT block the rest of the ring — after `MAX_ATTEMPTS` failures
// the offending job is dropped to a dead-letter counter and drained via
// the structured logger instead. That way, `isDbDegraded()` can recover
// even when a poison-pill write lands at the head.
// ---------------------------------------------------------------------------

export type RetryJob = () => Promise<void>;

interface RingEntry {
  job: RetryJob;
  attempts: number;
  label?: string;
}

export const MAX_RING = 1000;
export const MAX_ATTEMPTS = 5;

const ring: RingEntry[] = [];
let degradedUntil = 0;
let deadLettered = 0;

export function isDbDegraded(now: number = Date.now()): boolean {
  return degradedUntil > now || ring.length > 0;
}

export function enqueueRetry(job: RetryJob, label?: string): void {
  if (ring.length >= MAX_RING) {
    ring.shift();
  }
  ring.push({ job, attempts: 0, label });
  degradedUntil = Date.now() + 30_000;
}

/**
 * Attempt every pending job once. Jobs that throw are pushed to the tail
 * of the ring with an incremented attempt count; after `MAX_ATTEMPTS`
 * failures they are dead-lettered. This prevents a single permanently
 * broken job from blocking every subsequent write. Returns the number of
 * jobs that succeeded during this drain pass.
 */
export async function flushRetries(
  log?: (msg: string, err?: unknown) => void,
): Promise<number> {
  let flushed = 0;
  const pending = ring.length;
  for (let i = 0; i < pending; i++) {
    const entry = ring.shift();
    if (!entry) break;
    try {
      await entry.job();
      flushed += 1;
    } catch (err) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        deadLettered += 1;
        if (log) log('retry_dead_lettered', { err, label: entry.label, attempts: entry.attempts });
      } else {
        // Requeue at the tail so unrelated jobs can make progress while
        // this one is still failing.
        ring.push(entry);
        if (log) log('retry_requeued', { err, label: entry.label, attempts: entry.attempts });
      }
    }
  }
  if (ring.length === 0) degradedUntil = 0;
  return flushed;
}

export function ringSize(): number {
  return ring.length;
}

export function deadLetterCount(): number {
  return deadLettered;
}

export function _resetRing(): void {
  ring.length = 0;
  degradedUntil = 0;
  deadLettered = 0;
}
