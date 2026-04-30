/**
 * Thin fetch wrapper for the judge REST surface (§11.2).
 *
 * The schemas, SPA-facing types, and conversion helpers live in
 * `@tca-timer/shared/api` so the server (`server/src/routes/judge.ts`)
 * and this client cannot drift apart at the type level. This file is
 * intentionally tiny — just the SPA-specific HTTP machinery (cookies,
 * vite-proxied paths, runtime validation, error wrapping).
 *
 * Cloudflare Access handles auth at the edge via the `CF_Authorization`
 * cookie, which the browser sends automatically with `credentials: 'include'`.
 *
 * Every response body is validated against the shared zod schema before
 * being returned. Contract drift between the server and the SPA used
 * to surface as `undefined.length` deep inside React; now it surfaces
 * as a single `ApiError` with a precise zod path so the regression is
 * obvious from the network panel.
 */

import { z } from 'zod';

import {
  WireTicketSchema,
  WireRoomsEnvelopeSchema,
  WireAuditEnvelopeSchema,
  WirePrefsEnvelopeSchema,
  WireVerifyPhoneSchema,
  WireVerifyEmailSchema,
  prefsFromWire,
  prefsPatchToWire,
  roomFromWire,
  type TicketResponse,
  type RoomListEntry,
  type JudgePrefs,
  type AuditLogEntry,
} from '@tca-timer/shared/api';

export type {
  TicketResponse,
  RoomListEntry,
  JudgePrefs,
  AuditLogEntry,
  NotifyStatus,
} from '@tca-timer/shared/api';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  // Caller-provided headers (last spread below) win over defaults, but
  // we only set `content-type: application/json` when there's actually a
  // body. Fastify's default JSON parser rejects an empty body with
  // `FST_ERR_CTP_EMPTY_JSON_BODY` (HTTP 400) when the content-type is
  // application/json, which used to make every body-less POST (e.g.
  // `/api/judge/ticket`) fail.
  const hasBody = init?.body != null;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const merged: RequestInit = {
    credentials: 'include',
    ...init,
    headers,
  };
  const res = await fetch(path, merged);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) {
    // 204 No Content: schema must accept `undefined` for this to be
    // valid. Most endpoints don't, so this branch only fires for
    // explicit `z.void()`-shaped callers.
    return schema.parse(undefined);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, `${path}: response was not valid JSON`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(
      res.status,
      `${path}: response did not match expected shape (${describeIssues(result.error.issues)})`,
    );
  }
  return result.data;
}

function describeIssues(issues: z.ZodIssue[]): string {
  // Keep the message short — the path plus the first 3 issues is plenty
  // to debug from the network panel. More than 3 usually means a
  // fundamental mismatch where the first issue is enough to act on.
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

export const api = {
  mintTicket: async (): Promise<TicketResponse> => {
    const res = await req('/api/judge/ticket', WireTicketSchema, {
      method: 'POST',
    });
    return { ticket: res.ticket, expiresAt: Date.now() + res.expiresInMs };
  },

  listRooms: async (): Promise<RoomListEntry[]> => {
    const res = await req('/api/judge/rooms', WireRoomsEnvelopeSchema);
    return res.rooms.map(roomFromWire);
  },

  getLog: async (
    room: string,
    params?: { since?: number; limit?: number },
  ): Promise<AuditLogEntry[]> => {
    const q = new URLSearchParams({ room });
    if (params?.since != null) q.set('since', String(params.since));
    if (params?.limit != null) q.set('limit', String(params.limit));
    const res = await req(
      `/api/judge/log?${q.toString()}`,
      WireAuditEnvelopeSchema,
    );
    return res.entries;
  },

  csvLogUrl: (room: string, since?: number) => {
    const q = new URLSearchParams({ room });
    if (since != null) q.set('since', String(since));
    return `/api/judge/log.csv?${q.toString()}`;
  },

  getPrefs: async (): Promise<JudgePrefs> => {
    const res = await req('/api/judge/prefs', WirePrefsEnvelopeSchema);
    return prefsFromWire(res.prefs);
  },

  putPrefs: async (prefs: Partial<JudgePrefs>): Promise<JudgePrefs> => {
    const res = await req('/api/judge/prefs', WirePrefsEnvelopeSchema, {
      method: 'PUT',
      body: JSON.stringify(prefsPatchToWire(prefs)),
    });
    return prefsFromWire(res.prefs);
  },

  verifyPhone: async (code: string): Promise<{ status: string }> => {
    const res = await req(
      '/api/judge/prefs/verify-phone',
      WireVerifyPhoneSchema,
      { method: 'POST', body: JSON.stringify({ code }) },
    );
    return { status: res.phoneStatus };
  },

  verifyEmail: async (code: string): Promise<{ status: string }> => {
    const res = await req(
      '/api/judge/prefs/verify-email',
      WireVerifyEmailSchema,
      { method: 'POST', body: JSON.stringify({ code }) },
    );
    return { status: res.emailStatus };
  },
};
