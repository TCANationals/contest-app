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
  token_hash: string;
  created_at: Date;
  archived_at: Date | null;
}

async function _insertRoom(id: string, displayLabel: string, tokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO rooms (id, display_label, token_hash)
     VALUES ($1, $2, $3)`,
    [id, displayLabel, tokenHash],
  );
}

async function _updateRoomTokenHash(id: string, tokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE rooms SET token_hash = $2 WHERE id = $1`, [id, tokenHash]);
}

async function _getRoom(id: string): Promise<RoomRow | null> {
  if (!hasDatabase()) return null;
  const pool = getPool();
  const res = await pool.query<RoomRow>(
    `SELECT id, display_label, token_hash, created_at, archived_at
       FROM rooms WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function _listActiveRooms(): Promise<RoomRow[]> {
  if (!hasDatabase()) return [];
  const pool = getPool();
  const res = await pool.query<RoomRow>(
    `SELECT id, display_label, token_hash, created_at, archived_at
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

async function _upsertJudgePrefs(row: {
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
}): Promise<void> {
  const pool = getPool();
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
      ON CONFLICT (sub) DO UPDATE SET
        last_seen_email          = EXCLUDED.last_seen_email,
        phone_e164               = COALESCE(EXCLUDED.phone_e164, judge_prefs.phone_e164),
        phone_status             = COALESCE(EXCLUDED.phone_status, judge_prefs.phone_status),
        pending_phone_code_hash  = EXCLUDED.pending_phone_code_hash,
        pending_phone_expires_at = EXCLUDED.pending_phone_expires_at,
        email_address            = COALESCE(EXCLUDED.email_address, judge_prefs.email_address),
        email_status             = COALESCE(EXCLUDED.email_status, judge_prefs.email_status),
        pending_email_code_hash  = EXCLUDED.pending_email_code_hash,
        pending_email_expires_at = EXCLUDED.pending_email_expires_at,
        enabled_rooms            = EXCLUDED.enabled_rooms,
        quiet_hours_start        = EXCLUDED.quiet_hours_start,
        quiet_hours_end          = EXCLUDED.quiet_hours_end,
        quiet_hours_weekdays     = EXCLUDED.quiet_hours_weekdays,
        timezone                 = EXCLUDED.timezone,
        updated_at               = now()`,
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
  room: string;
  atServerMs: number;
  actorSub: string;
  actorEmail: string | null;
  eventType: string;
  payload: unknown;
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
    `SELECT room, at_server_ms, actor_sub, actor_email, event_type, payload
       FROM audit_log
       ${where}
       ORDER BY at_server_ms DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return res.rows.map((r: {
    room: string;
    at_server_ms: string | number;
    actor_sub: string;
    actor_email: string | null;
    event_type: string;
    payload: unknown;
  }) => ({
    room: r.room,
    atServerMs: Number(r.at_server_ms),
    actorSub: r.actor_sub,
    actorEmail: r.actor_email,
    eventType: r.event_type,
    payload: r.payload,
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
}

export const __testOverrides: DalOverrides = {};

// ---------------------------------------------------------------------------
// Public exports route through the override hook.
// ---------------------------------------------------------------------------

export const insertRoom = _insertRoom;
export const updateRoomTokenHash = _updateRoomTokenHash;
export const upsertJudgePrefs = _upsertJudgePrefs;
export const setPhoneStatus = _setPhoneStatus;
export const setEmailStatus = _setEmailStatus;

export function getRoom(id: string): Promise<RoomRow | null> {
  return (__testOverrides.getRoom ?? _getRoom)(id);
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
// ---------------------------------------------------------------------------

export type RetryJob = () => Promise<void>;

const MAX_RING = 1000;
const ring: RetryJob[] = [];
let degradedUntil = 0;

export function isDbDegraded(now: number = Date.now()): boolean {
  return degradedUntil > now || ring.length > 0;
}

export function enqueueRetry(job: RetryJob): void {
  if (ring.length >= MAX_RING) {
    ring.shift();
  }
  ring.push(job);
  degradedUntil = Date.now() + 30_000;
}

export async function flushRetries(log?: (msg: string, err?: unknown) => void): Promise<number> {
  let flushed = 0;
  while (ring.length > 0) {
    const job = ring.shift()!;
    try {
      await job();
      flushed += 1;
    } catch (err) {
      ring.unshift(job);
      if (log) log('retry_flush_stalled', err);
      break;
    }
  }
  if (ring.length === 0) degradedUntil = 0;
  return flushed;
}

export function ringSize(): number {
  return ring.length;
}

export function _resetRing(): void {
  ring.length = 0;
  degradedUntil = 0;
}
