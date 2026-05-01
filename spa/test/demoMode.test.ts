/**
 * Regression test for the demo-mode fetch shim.
 *
 * The SPA's API client (`spa/src/api/client.ts`) validates every
 * response against the zod schemas in `@tca-timer/shared/api`. If
 * the demo shim drifts from the wire shape — as it did before —
 * every REST call in demo mode throws `ApiError` and the preview is
 * unusable. These tests parse each demo response with the *real*
 * zod schema so any future schema rename or field addition that
 * isn't mirrored in `demoMode.ts` fails here loudly rather than
 * silently breaking demo browsing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WireMeSchema,
  WireTicketSchema,
  WireRoomsEnvelopeSchema,
  WireAuditEnvelopeSchema,
  WirePrefsEnvelopeSchema,
  WireVerifyPhoneSchema,
  WireVerifyEmailSchema,
} from '@tca-timer/shared/api';

import { _resetDemoPrefs, installDemoMode } from '../src/lib/demoMode';

const realFetch = window.fetch.bind(window);
const PREFS_KEY = 'tca-timer.demo.prefs';

beforeEach(() => {
  // Reset the install guard + restore the original fetch so each
  // test installs a fresh shim. `installDemoMode` is idempotent via a
  // window flag, so we have to clear that too.
  //
  // We deliberately call `removeItem` rather than `localStorage.clear()`
  // because jsdom's `Storage.clear` is missing in the version pinned
  // by the SPA test environment (same quirk that makes
  // `rooms.test.ts` flaky), so a targeted remove is the only stable
  // option until that's resolved upstream. The demo's in-memory
  // cache is reset separately because jsdom's `setItem` is also
  // non-functional in this version, so localStorage alone wouldn't
  // round-trip a PUT.
  (window as unknown as { __tcaDemoInstalled?: boolean }).__tcaDemoInstalled = false;
  window.fetch = realFetch;
  try {
    window.localStorage.removeItem(PREFS_KEY);
  } catch {
    /* noop */
  }
  _resetDemoPrefs();
  installDemoMode();
});

afterEach(() => {
  (window as unknown as { __tcaDemoInstalled?: boolean }).__tcaDemoInstalled = false;
  window.fetch = realFetch;
  try {
    window.localStorage.removeItem(PREFS_KEY);
  } catch {
    /* noop */
  }
  _resetDemoPrefs();
});

describe('demoMode REST shim matches wire schemas', () => {
  it('GET /api/auth/me returns WireMe with admin access', async () => {
    const res = await window.fetch('/api/auth/me');
    expect(res.ok).toBe(true);
    const parsed = WireMeSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.access).toBe('all');
      expect(parsed.data.email.length).toBeGreaterThan(0);
    }
  });

  it('POST /api/auth/logout returns ok', async () => {
    const res = await window.fetch('/api/auth/logout', { method: 'POST' });
    expect(res.ok).toBe(true);
  });

  it('POST /api/judge/ticket returns WireTicket envelope', async () => {
    const res = await window.fetch('/api/judge/ticket', { method: 'POST' });
    expect(res.ok).toBe(true);
    const body = await res.json();
    const parsed = WireTicketSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ticket.length).toBeGreaterThan(0);
      expect(parsed.data.expiresInMs).toBeGreaterThan(0);
    }
  });

  it('GET /api/judge/rooms returns the {rooms: WireRoom[]} envelope', async () => {
    const res = await window.fetch('/api/judge/rooms');
    expect(res.ok).toBe(true);
    const body = await res.json();
    const parsed = WireRoomsEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rooms.length).toBeGreaterThan(0);
      // Every entry MUST use `display_label` (snake_case wire shape),
      // not the SPA-facing `displayLabel` — that's the regression we're
      // guarding against.
      for (const r of parsed.data.rooms) {
        expect(r.id.length).toBeGreaterThan(0);
        expect(r.display_label.length).toBeGreaterThan(0);
      }
    }
  });

  it('GET /api/judge/log returns the {entries: WireAuditEntry[]} envelope', async () => {
    const res = await window.fetch('/api/judge/log?room=demo-room');
    expect(res.ok).toBe(true);
    const body = await res.json();
    const parsed = WireAuditEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries.length).toBeGreaterThan(0);
    }
  });

  it('GET /api/judge/prefs returns the {prefs: WirePrefs} envelope', async () => {
    const res = await window.fetch('/api/judge/prefs');
    expect(res.ok).toBe(true);
    const body = await res.json();
    const parsed = WirePrefsEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Wire-format names the field `email`, not the SPA-facing
      // `lastSeenEmail`. `prefsFromWire` does the rename downstream.
      expect(parsed.data.prefs.email.length).toBeGreaterThan(0);
      expect(parsed.data.prefs.timezone.length).toBeGreaterThan(0);
    }
  });

  it('PUT /api/judge/prefs persists patches and returns the merged WirePrefs', async () => {
    const put = await window.fetch('/api/judge/prefs', {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'Europe/London', enabledRooms: ['demo-room'] }),
    });
    expect(put.ok).toBe(true);
    const putBody = await put.json();
    const putParsed = WirePrefsEnvelopeSchema.safeParse(putBody);
    expect(putParsed.success).toBe(true);
    if (putParsed.success) {
      expect(putParsed.data.prefs.timezone).toBe('Europe/London');
      expect(putParsed.data.prefs.enabledRooms).toEqual(['demo-room']);
    }

    // The patch persists across requests — a follow-up GET shows the
    // same values.
    const get = await window.fetch('/api/judge/prefs');
    const getParsed = WirePrefsEnvelopeSchema.safeParse(await get.json());
    expect(getParsed.success).toBe(true);
    if (getParsed.success) {
      expect(getParsed.data.prefs.timezone).toBe('Europe/London');
    }
  });

  it('POST /api/judge/prefs/verify-phone returns WireVerifyPhone', async () => {
    const res = await window.fetch('/api/judge/prefs/verify-phone', {
      method: 'POST',
      body: JSON.stringify({ code: '123456' }),
    });
    const parsed = WireVerifyPhoneSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });

  it('POST /api/judge/prefs/verify-email returns WireVerifyEmail', async () => {
    const res = await window.fetch('/api/judge/prefs/verify-email', {
      method: 'POST',
      body: JSON.stringify({ code: '123456' }),
    });
    const parsed = WireVerifyEmailSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });
});
