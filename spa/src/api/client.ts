/**
 * Thin fetch wrapper for the judge REST surface (§11.2).
 *
 * The schemas, SPA-facing types, and conversion helpers live in
 * `@tca-timer/shared/api` so the server (`server/src/routes/judge.ts`)
 * and this client cannot drift apart at the type level. This file is
 * intentionally tiny — just the SPA-specific HTTP machinery (cookies,
 * vite-proxied paths, runtime validation, error wrapping).
 *
 * Auth: the server is an OIDC client (`server/src/auth/oidc.ts`) and
 * sets an encrypted, HttpOnly `tca_sess` cookie after a successful
 * login. The browser sends it automatically with `credentials: 'include'`.
 * When the cookie is missing or expired, the server returns 401
 * `no_session`; this module traps that and navigates the *browser* to
 * `/api/auth/login?return_to=…` so the IdP redirect dance can run.
 *
 * Every response body is validated against the shared zod schema before
 * being returned. Contract drift between the server and the SPA used
 * to surface as `undefined.length` deep inside React; now it surfaces
 * as a single `ApiError` with a precise zod path so the regression is
 * obvious from the network panel.
 */

import { z } from 'zod';

import {
  WireMeSchema,
  WireTicketSchema,
  WireRoomsEnvelopeSchema,
  WireAuditEnvelopeSchema,
  WirePrefsEnvelopeSchema,
  WireVerifyPhoneSchema,
  WireVerifyEmailSchema,
  meFromWire,
  prefsFromWire,
  prefsPatchToWire,
  roomFromWire,
  type TicketResponse,
  type RoomListEntry,
  type JudgePrefs,
  type JudgeSession,
  type AuditLogEntry,
} from '@tca-timer/shared/api';

export type {
  TicketResponse,
  RoomListEntry,
  JudgePrefs,
  JudgeSession,
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

/**
 * 401 → full-page redirect to the OIDC login flow.
 *
 * Why a full-page redirect rather than letting `fetch` follow the IdP
 * 302: browsers silently follow 30x for XHR/fetch, and the IdP would
 * respond with HTML that we'd then try to JSON-parse. The server
 * therefore answers protected endpoints with 401 + a `login` hint
 * instead, and we hand the browser the URL so it does the navigation
 * (which the IdP can then properly 302).
 *
 * The `return_to` query string brings the user back to where they
 * were once the callback fires. Same-origin paths only — guarded on
 * the server side as well to avoid open-redirect abuse.
 */
function redirectToLogin(): never {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const url = `/api/auth/login?return_to=${encodeURIComponent(here)}`;
  // Best-effort: don't redirect-loop if we're already on a login URL.
  if (!window.location.pathname.startsWith('/api/auth/')) {
    window.location.assign(url);
  }
  // The promise never resolves — the navigation aborts the call.
  // Throwing keeps TypeScript happy and ensures react-query treats
  // the call as a failure (not a successful undefined) if for some
  // reason the navigation doesn't happen.
  throw new ApiError(401, 'redirecting to login');
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
  if (res.status === 401) {
    redirectToLogin();
  }
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
  me: async (): Promise<JudgeSession> => {
    const res = await req('/api/auth/me', WireMeSchema);
    return meFromWire(res);
  },

  logout: async (): Promise<void> => {
    // Bypasses `req()` so we don't trip the 401-redirect trap when the
    // server reports "no session" on the way out.
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.assign('/');
  },

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
