/**
 * Single source of truth for the judge REST API contract (§11.2).
 *
 * Both the Fastify server (`server/src/routes/judge.ts`) and the React
 * SPA (`spa/src/api/client.ts`) import from this module. The schemas
 * describe the on-the-wire JSON shape; the SPA-facing types are what
 * components actually consume after the API client unwraps single-key
 * envelopes (`{ rooms }`, `{ prefs }`, `{ entries }`) and renames a
 * couple of fields (`email` → `lastSeenEmail`).
 *
 * Conventions:
 *
 *   * `Wire*Schema`        — zod schema for a single record on the wire.
 *   * `Wire*EnvelopeSchema` — schema for the `{ key: ... }` envelope.
 *   * `Wire*`              — type inferred from the wire schema.
 *   * Plain interface (no Wire prefix) — the SPA-facing shape.
 *
 * The server can use the wire schemas to type its handler return
 * values (so a missing field is a type error at compile time) and
 * optionally to `parse()` outgoing payloads as a self-check. The SPA
 * uses the same schemas to validate incoming payloads at runtime, so
 * any contract drift surfaces immediately as a precise zod error
 * rather than a deep React crash.
 *
 * This module lives at `@tca-timer/shared/api` rather than being
 * re-exported from the top-level barrel so that the Tauri contestant
 * overlay (which only consumes the timer-display helpers) doesn't pull
 * zod into its bundle.
 */

import { z } from 'zod';

import type { TimerState } from '../types';

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

export const NotifyStatusSchema = z.enum([
  'none',
  'pending',
  'verified',
  'opted_out',
]);
export type NotifyStatus = z.infer<typeof NotifyStatusSchema>;

// ---------------------------------------------------------------------------
// Tickets — POST /api/judge/ticket.
// ---------------------------------------------------------------------------

export const WireTicketSchema = z.object({
  ticket: z.string().min(1),
  /** Relative TTL from the moment the response left the server. */
  expiresInMs: z.number().int().nonnegative(),
});
export type WireTicket = z.infer<typeof WireTicketSchema>;

/** What the SPA exposes — absolute deadline so callers can compare to `Date.now()`. */
export interface TicketResponse {
  ticket: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Rooms — GET /api/judge/rooms.
// ---------------------------------------------------------------------------

export const WireRoomSchema = z.object({
  id: z.string(),
  display_label: z.string(),
  // Postgres timestamps come through as ISO strings; tolerate Date too
  // in case the server ever emits an unserialized value.
  created_at: z.union([z.string(), z.date()]).optional(),
});
export type WireRoom = z.infer<typeof WireRoomSchema>;

export const WireRoomsEnvelopeSchema = z.object({
  rooms: z.array(WireRoomSchema),
});

export interface RoomListEntry {
  id: string;
  displayLabel: string;
}

export function roomFromWire(r: WireRoom): RoomListEntry {
  return { id: r.id, displayLabel: r.display_label };
}

// ---------------------------------------------------------------------------
// Audit log — GET /api/judge/log.
// ---------------------------------------------------------------------------

export const WireAuditEntrySchema = z.object({
  // Server fills `id` on persistence; tolerate either int or stringy id
  // in case Postgres bigints come through serialized.
  id: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  room: z.string(),
  atServerMs: z.number(),
  actorSub: z.string(),
  actorEmail: z.string().nullable(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type AuditLogEntry = z.infer<typeof WireAuditEntrySchema>;

export const WireAuditEnvelopeSchema = z.object({
  entries: z.array(WireAuditEntrySchema),
});

// ---------------------------------------------------------------------------
// Judge prefs — GET / PUT /api/judge/prefs.
//
// The SPA-facing `JudgePrefs` differs from the wire shape in one place:
// the server emits `email` (the most recent CF Access email it observed)
// alongside `emailAddress` (the user's verified notification address).
// The SPA renames the former to `lastSeenEmail` to make the distinction
// obvious in component code.
// ---------------------------------------------------------------------------

export const WirePrefsSchema = z.object({
  sub: z.string(),
  email: z.string(),
  phoneE164: z.string().nullable(),
  phoneStatus: NotifyStatusSchema,
  emailAddress: z.string().nullable(),
  emailStatus: NotifyStatusSchema,
  enabledRooms: z.array(z.string()).default([]),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  quietHoursWeekdays: z.number().int().default(0),
  timezone: z.string(),
});
export type WirePrefs = z.infer<typeof WirePrefsSchema>;

export const WirePrefsEnvelopeSchema = z.object({ prefs: WirePrefsSchema });

export interface JudgePrefs {
  sub: string;
  /** Most recent CF Access email observed for this judge (server-derived). */
  lastSeenEmail: string;
  phoneE164: string | null;
  phoneStatus: NotifyStatus;
  emailAddress: string | null;
  emailStatus: NotifyStatus;
  enabledRooms: string[];
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursWeekdays: number;
  timezone: string;
}

export function prefsFromWire(p: WirePrefs): JudgePrefs {
  return {
    sub: p.sub,
    lastSeenEmail: p.email,
    phoneE164: p.phoneE164,
    phoneStatus: p.phoneStatus,
    emailAddress: p.emailAddress,
    emailStatus: p.emailStatus,
    enabledRooms: p.enabledRooms,
    quietHoursStart: p.quietHoursStart,
    quietHoursEnd: p.quietHoursEnd,
    quietHoursWeekdays: p.quietHoursWeekdays,
    timezone: p.timezone,
  };
}

/**
 * Strip SPA-only fields before sending a prefs patch to the server.
 *
 * `lastSeenEmail` is server-derived (from CF Access) and `sub` is
 * picked from the JWT identity, so neither belongs in a PUT payload.
 */
export function prefsPatchToWire(
  p: Partial<JudgePrefs>,
): Record<string, unknown> {
  const { lastSeenEmail: _e, sub: _s, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------------------
// Verification flows — POST /api/judge/prefs/verify-{phone,email}.
// ---------------------------------------------------------------------------

export const WireVerifyPhoneSchema = z.object({
  phoneStatus: NotifyStatusSchema,
});
export type WireVerifyPhone = z.infer<typeof WireVerifyPhoneSchema>;

export const WireVerifyEmailSchema = z.object({
  emailStatus: NotifyStatusSchema,
});
export type WireVerifyEmail = z.infer<typeof WireVerifyEmailSchema>;

// ---------------------------------------------------------------------------
// WebSocket frames — `/judge` and `/contestant` per §5.2.
//
// Wire format reminders (matching `server/src/rooms.ts:stateFrame`):
//   * `STATE` is `{ type: 'STATE' } & TimerState` — fields are spread
//     onto the frame, *not* nested under a `state` key. Both this
//     module and the integration tests in `server/test/ws.*` rely on
//     that shape; clients must access `frame.status` rather than
//     `frame.state.status`.
//   * `HELP_QUEUE` similarly spreads `HelpQueue` onto the frame.
//
// The schemas below are exported so consumers (SPA, contestant
// overlay) can validate inbound frames at runtime. The contestant
// overlay opts in to validation explicitly via
// `ContestantInboundFrameSchema`; if the bundle size becomes an
// issue, drop the import there and fall back to the inferred types
// (which are fully erased by the bundler).
// ---------------------------------------------------------------------------

export const TimerStatusSchema = z.enum(['idle', 'running', 'paused']);
export type TimerStatus = z.infer<typeof TimerStatusSchema>;

/**
 * Shape of `TimerState` (also defined in `../types.ts` for the
 * type-only consumers). Kept in sync by hand — there's only one
 * boolean / number / string list that's allowed to drift.
 */
export const TimerStateSchema = z.object({
  room: z.string(),
  version: z.number().int(),
  status: TimerStatusSchema,
  endsAtServerMs: z.number().nullable(),
  remainingMs: z.number().nullable(),
  message: z.string(),
  setBySub: z.string(),
  setByEmail: z.string(),
  setAtServerMs: z.number(),
  // SPA-only decorations — optional in the wire shape so the
  // contestant overlay's parser doesn't reject frames that do or
  // don't carry them.
  connectedContestants: z.number().int().optional(),
  dbDegraded: z.boolean().optional(),
});

export const HelpQueueEntrySchema = z.object({
  contestantId: z.string(),
  stationNumber: z.number().int().nullable(),
  requestedAtServerMs: z.number(),
});
export type HelpQueueEntry = z.infer<typeof HelpQueueEntrySchema>;

export const HelpQueueSchema = z.object({
  room: z.string(),
  version: z.number().int(),
  entries: z.array(HelpQueueEntrySchema),
});
export type HelpQueue = z.infer<typeof HelpQueueSchema>;

/** §5.2 STATE frame — server → both consumers. Spreads `TimerState`. */
export const StateFrameSchema = TimerStateSchema.extend({
  type: z.literal('STATE'),
});
export type StateFrame = z.infer<typeof StateFrameSchema>;

/** §6.3 PONG frame — server → both consumers. */
export const PongFrameSchema = z.object({
  type: z.literal('PONG'),
  t0: z.number(),
  t1: z.number(),
  t2: z.number(),
});
export type PongFrame = z.infer<typeof PongFrameSchema>;

/** §5.2 HELP_QUEUE frame — server → judge only. Spreads `HelpQueue`. */
export const HelpQueueFrameSchema = HelpQueueSchema.extend({
  type: z.literal('HELP_QUEUE'),
});
export type HelpQueueFrame = z.infer<typeof HelpQueueFrameSchema>;

/** §5.2 ERROR frame — server → either consumer. */
export const ErrorFrameSchema = z.object({
  type: z.literal('ERROR'),
  code: z.string(),
  message: z.string(),
});
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/**
 * §7.1 HELP_ACKED frame — server → the specific contestant whose help
 * request was just acknowledged by a judge. Contestants don't receive
 * `HELP_QUEUE` (judge-only by §5.2), so this targeted notification is
 * how the overlay learns its `help_pending` state has cleared and can
 * raise the spec'd "Judge acknowledged" toast before reverting the
 * button.
 *
 * `version` is the queue version *after* the ack so the overlay can
 * correlate with the `HELP_ACK` it would have sent had it self-
 * cancelled at the same instant. `waitMs` is the same value the
 * server records in the audit log for this contestant.
 */
export const HelpAckedFrameSchema = z.object({
  type: z.literal('HELP_ACKED'),
  room: z.string(),
  contestantId: z.string(),
  version: z.number().int(),
  waitMs: z.number(),
  ackedAtServerMs: z.number(),
});
export type HelpAckedFrame = z.infer<typeof HelpAckedFrameSchema>;

/** §5.2 server → judge inbound. */
export const JudgeInboundFrameSchema = z.discriminatedUnion('type', [
  StateFrameSchema,
  PongFrameSchema,
  HelpQueueFrameSchema,
  ErrorFrameSchema,
]);
export type JudgeInboundFrame = z.infer<typeof JudgeInboundFrameSchema>;

/** §5.2 server → contestant inbound. Contestants never see the help queue. */
export const ContestantInboundFrameSchema = z.discriminatedUnion('type', [
  StateFrameSchema,
  PongFrameSchema,
  HelpAckedFrameSchema,
  ErrorFrameSchema,
]);
export type ContestantInboundFrame = z.infer<typeof ContestantInboundFrameSchema>;

/**
 * Superset of every frame the server can emit — used by the server's
 * outbound-frame contract check (`server/src/rooms.ts`) so a single
 * schema validates STATE / PONG / HELP_QUEUE / HELP_ACKED / ERROR
 * regardless of whether the destination is a judge or a contestant
 * socket. The narrower per-consumer schemas above are still used for
 * inbound validation on each client.
 */
export const ServerOutboundFrameSchema = z.discriminatedUnion('type', [
  StateFrameSchema,
  PongFrameSchema,
  HelpQueueFrameSchema,
  HelpAckedFrameSchema,
  ErrorFrameSchema,
]);
export type ServerOutboundFrame = z.infer<typeof ServerOutboundFrameSchema>;

/** §5.2 judge → server outbound. */
export const JudgeOutboundFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING'), t0: z.number() }),
  z.object({
    type: z.literal('TIMER_SET'),
    durationMs: z.number(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('TIMER_PAUSE') }),
  z.object({ type: z.literal('TIMER_RESUME') }),
  z.object({ type: z.literal('TIMER_ADJUST'), deltaMs: z.number() }),
  z.object({ type: z.literal('TIMER_RESET') }),
  z.object({
    type: z.literal('HELP_ACK'),
    contestantId: z.string(),
    version: z.number().int().optional(),
  }),
]);
export type JudgeOutboundFrame = z.infer<typeof JudgeOutboundFrameSchema>;

/** §5.2 contestant → server outbound. */
export const ContestantOutboundFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING'), t0: z.number() }),
  z.object({ type: z.literal('HELP_REQUEST') }),
  z.object({ type: z.literal('HELP_CANCEL') }),
]);
export type ContestantOutboundFrame = z.infer<typeof ContestantOutboundFrameSchema>;
