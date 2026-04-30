/**
 * Thin fetch wrapper for the judge REST surface (§11.2).
 *
 * Cloudflare Access handles auth at the edge via the `CF_Authorization`
 * cookie, which the browser sends automatically with `credentials: 'include'`.
 */

export interface TicketResponse {
  ticket: string;
  expiresAt: number;
}

export interface RoomListEntry {
  id: string;
  displayLabel: string;
}

export interface AuditLogEntry {
  id: number;
  room: string;
  atServerMs: number;
  actorSub: string;
  actorEmail: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface JudgePrefs {
  sub: string;
  lastSeenEmail: string;
  phoneE164: string | null;
  phoneStatus: 'none' | 'pending' | 'verified' | 'opted_out';
  emailAddress: string | null;
  emailStatus: 'none' | 'pending' | 'verified' | 'opted_out';
  enabledRooms: string[];
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursWeekdays: number;
  timezone: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  mintTicket: () => req<TicketResponse>('/api/judge/ticket', { method: 'POST' }),

  listRooms: () => req<RoomListEntry[]>('/api/judge/rooms'),

  getLog: (room: string, params?: { since?: number; limit?: number }) => {
    const q = new URLSearchParams({ room });
    if (params?.since != null) q.set('since', String(params.since));
    if (params?.limit != null) q.set('limit', String(params.limit));
    return req<AuditLogEntry[]>(`/api/judge/log?${q.toString()}`);
  },

  csvLogUrl: (room: string, since?: number) => {
    const q = new URLSearchParams({ room });
    if (since != null) q.set('since', String(since));
    return `/api/judge/log.csv?${q.toString()}`;
  },

  getPrefs: () => req<JudgePrefs>('/api/judge/prefs'),

  putPrefs: (prefs: Partial<JudgePrefs>) =>
    req<JudgePrefs>('/api/judge/prefs', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  verifyPhone: (code: string) =>
    req<{ status: string }>('/api/judge/prefs/verify-phone', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  verifyEmail: (code: string) =>
    req<{ status: string }>('/api/judge/prefs/verify-email', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
};
