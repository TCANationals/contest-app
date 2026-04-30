/**
 * In-memory demo transport for previewing the SPA without a backend.
 *
 * Activated by `?demo=1` in the URL or by running the Vite dev server with
 * `VITE_DEMO_MODE=1`. Simulates:
 *   • /api/judge/* endpoints via `fetch` interception.
 *   • WebSocket STATE / HELP_QUEUE / PONG frames for two rooms.
 *
 * This is scaffolding to let humans click through the SPA and is never
 * enabled in production builds unless explicitly turned on.
 */

import type { HelpQueue, TimerState } from '../store/types';

type Listener = (data: string) => void;

interface DemoRoom {
  displayLabel: string;
  timer: TimerState;
  help: HelpQueue;
}

const rooms: Record<string, DemoRoom> = {
  'demo-room': {
    displayLabel: 'Demo Room',
    timer: makeIdleTimer('demo-room'),
    help: { room: 'demo-room', version: 1, entries: [] },
  },
  'practice-2026': {
    displayLabel: 'Practice 2026',
    timer: makeIdleTimer('practice-2026'),
    help: { room: 'practice-2026', version: 1, entries: [] },
  },
};

function makeIdleTimer(room: string): TimerState {
  return {
    room,
    version: 1,
    status: 'idle',
    endsAtServerMs: null,
    remainingMs: null,
    message: '',
    setBySub: 'system',
    setByEmail: 'demo@example.com',
    setAtServerMs: Date.now(),
    connectedContestants: 3,
    dbDegraded: false,
  };
}

export class DemoJudgeSocket {
  readyState = 0 as 0 | 1 | 2 | 3;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  private room: string;
  private listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };
  private pushedState = false;
  private unsubscribe?: () => void;

  constructor(url: string) {
    const q = new URL(url, 'http://localhost');
    this.room = q.searchParams.get('room') ?? 'demo-room';
    if (!rooms[this.room]) {
      rooms[this.room] = {
        displayLabel: this.room,
        timer: makeIdleTimer(this.room),
        help: { room: this.room, version: 1, entries: [] },
      };
    }
    setTimeout(() => this.open(), 50);
  }

  addEventListener(kind: keyof DemoJudgeSocket['listeners'], cb: Listener) {
    (this.listeners[kind] ??= []).push(cb);
  }
  removeEventListener(kind: keyof DemoJudgeSocket['listeners'], cb: Listener) {
    this.listeners[kind] = (this.listeners[kind] ?? []).filter((f) => f !== cb);
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const r = rooms[this.room];
    if (!r) return;

    const bump = () => {
      r.timer = { ...r.timer, version: r.timer.version + 1, setAtServerMs: Date.now() };
      this.emit('message', JSON.stringify({ type: 'STATE', state: r.timer }));
    };

    switch (frame.type) {
      case 'PING': {
        const t0 = Number(frame.t0 ?? 0);
        this.emit('message', JSON.stringify({ type: 'PONG', t0, t1: Date.now(), t2: Date.now() }));
        break;
      }
      case 'TIMER_SET': {
        const durationMs = Number(frame.durationMs ?? 0) || 0;
        r.timer = {
          ...r.timer,
          status: 'running',
          endsAtServerMs: Date.now() + durationMs,
          remainingMs: null,
          message: typeof frame.message === 'string' ? frame.message : '',
        };
        bump();
        break;
      }
      case 'TIMER_PAUSE': {
        if (r.timer.status === 'running' && r.timer.endsAtServerMs != null) {
          r.timer = {
            ...r.timer,
            status: 'paused',
            remainingMs: Math.max(0, r.timer.endsAtServerMs - Date.now()),
            endsAtServerMs: null,
          };
          bump();
        }
        break;
      }
      case 'TIMER_RESUME': {
        if (r.timer.status === 'paused' && r.timer.remainingMs != null) {
          r.timer = {
            ...r.timer,
            status: 'running',
            endsAtServerMs: Date.now() + r.timer.remainingMs,
            remainingMs: null,
          };
          bump();
        }
        break;
      }
      case 'TIMER_ADJUST': {
        const delta = Number(frame.deltaMs ?? 0) || 0;
        if (r.timer.status === 'running' && r.timer.endsAtServerMs != null) {
          r.timer = { ...r.timer, endsAtServerMs: r.timer.endsAtServerMs + delta };
          bump();
        } else if (r.timer.status === 'paused' && r.timer.remainingMs != null) {
          r.timer = { ...r.timer, remainingMs: Math.max(0, r.timer.remainingMs + delta) };
          bump();
        }
        break;
      }
      case 'TIMER_RESET': {
        r.timer = { ...r.timer, status: 'idle', endsAtServerMs: null, remainingMs: null, message: '' };
        bump();
        break;
      }
      case 'HELP_ACK': {
        const cid = String(frame.contestantId ?? '');
        r.help = {
          ...r.help,
          version: r.help.version + 1,
          entries: r.help.entries.filter((e) => e.contestantId !== cid),
        };
        this.emit('message', JSON.stringify({ type: 'HELP_QUEUE', queue: r.help }));
        break;
      }
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.unsubscribe) this.unsubscribe();
    this.emit('close', '');
  }

  private open() {
    if (this.readyState === 3) return;
    this.readyState = 1;
    this.emit('open', '');
    const r = rooms[this.room];
    if (!r) {
      return;
    }
    if (!this.pushedState) {
      this.emit('message', JSON.stringify({ type: 'STATE', state: r.timer }));
      this.emit('message', JSON.stringify({ type: 'HELP_QUEUE', queue: r.help }));
      this.pushedState = true;
    }
    // Seed a help-request after 3s for UX preview.
    const id = window.setTimeout(() => {
      if (this.readyState !== DemoJudgeSocket.OPEN) return;
      const help = rooms[this.room];
      if (!help || help.help.entries.length > 0) return;
      help.help = {
        ...help.help,
        version: help.help.version + 1,
        entries: [
          {
            contestantId: 'contestant-07',
            stationNumber: 12,
            requestedAtServerMs: Date.now(),
          },
        ],
      };
      this.emit('message', JSON.stringify({ type: 'HELP_QUEUE', queue: help.help }));
    }, 3000);
    this.unsubscribe = () => window.clearTimeout(id);
  }

  private emit(kind: string, data: string) {
    const arr = this.listeners[kind];
    if (!arr) return;
    for (const l of arr) {
      try {
        l(data);
      } catch {
        /* noop */
      }
    }
  }
}

/** Install fetch + WebSocket shims when demo mode is active. */
export function installDemoMode(): void {
  if ((window as unknown as { __tcaDemoInstalled?: boolean }).__tcaDemoInstalled) return;
  (window as unknown as { __tcaDemoInstalled?: boolean }).__tcaDemoInstalled = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (u.pathname === '/api/judge/ticket' && method === 'POST') {
      return jsonResponse({ ticket: 'demo-ticket', expiresAt: Date.now() + 30_000 });
    }
    if (u.pathname === '/api/judge/rooms' && method === 'GET') {
      return jsonResponse(
        Object.entries(rooms).map(([id, r]) => ({ id, displayLabel: r.displayLabel })),
      );
    }
    if (u.pathname === '/api/judge/log' && method === 'GET') {
      const room = u.searchParams.get('room') ?? '';
      const now = Date.now();
      return jsonResponse([
        {
          id: 1,
          room,
          atServerMs: now - 60_000,
          actorSub: 'demo-judge',
          actorEmail: 'demo@example.com',
          eventType: 'TIMER_SET',
          payload: { durationMs: 300_000, message: 'Practice block' },
        },
        {
          id: 2,
          room,
          atServerMs: now - 45_000,
          actorSub: 'system',
          actorEmail: null,
          eventType: 'HELP_REQUEST',
          payload: { contestantId: 'contestant-04' },
        },
        {
          id: 3,
          room,
          atServerMs: now - 30_000,
          actorSub: 'demo-judge',
          actorEmail: 'demo@example.com',
          eventType: 'HELP_ACK',
          payload: { contestantId: 'contestant-04', waitMs: 15_000 },
        },
      ]);
    }
    if (u.pathname.startsWith('/api/judge/log.csv')) {
      const body = [
        'id,room,at_server_ms,actor_sub,actor_email,event_type,payload',
        `1,${u.searchParams.get('room')},${Date.now() - 60_000},demo-judge,demo@example.com,TIMER_SET,"{""durationMs"":300000}"`,
      ].join('\n');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    }
    if (u.pathname === '/api/judge/prefs') {
      if (method === 'GET') {
        return jsonResponse(getPrefs());
      }
      if (method === 'PUT') {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        setPrefs(body);
        return jsonResponse(getPrefs());
      }
    }
    return realFetch(input, init);
  };

  const realWS = window.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as unknown as { WebSocket: any }).WebSocket = function (url: string) {
    const u = new URL(url, window.location.origin);
    if (u.pathname === '/judge') return new DemoJudgeSocket(url);
    return new realWS(url);
  };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const prefsKey = 'tca-timer.demo.prefs';

function getPrefs() {
  try {
    const raw = window.localStorage.getItem(prefsKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* noop */
  }
  return {
    sub: 'demo-judge',
    lastSeenEmail: 'demo@example.com',
    phoneE164: null,
    phoneStatus: 'none',
    emailAddress: null,
    emailStatus: 'none',
    enabledRooms: [],
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursWeekdays: 0,
    timezone: 'America/Chicago',
  };
}

function setPrefs(patch: Record<string, unknown>): void {
  const next = { ...getPrefs(), ...patch };
  try {
    window.localStorage.setItem(prefsKey, JSON.stringify(next));
  } catch {
    /* noop */
  }
}

export function demoModeActive(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (import.meta as any)?.env?.VITE_DEMO_MODE;
    return env === '1' || env === 'true';
  } catch {
    return false;
  }
}
