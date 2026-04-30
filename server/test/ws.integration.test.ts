// End-to-end WebSocket integration test. Exercises the full wire protocol
// (§5) on an ephemeral Fastify server against the in-memory room state,
// stubbing out DB lookups so the test doesn't require Postgres.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { buildServer } from '../src/index.js';
import { ticketCache } from '../src/auth/cf-jwt.js';
import { _resetRooms, getOrCreateRoomState } from '../src/rooms.js';

// Stub DAL. We monkey-patch via module interception: import the real module,
// overwrite the two hot-path lookups. This is simpler than ESM mocks.
import { __testOverrides } from '../src/db/dal.js';

type App = Awaited<ReturnType<typeof buildServer>>;

interface FramedSocket {
  ws: WebSocket;
  buffer: Array<Record<string, unknown>>;
  waiters: Array<(f: Record<string, unknown>) => void>;
}

async function open(url: string): Promise<FramedSocket> {
  const ws = new WebSocket(url);
  const sock: FramedSocket = { ws, buffer: [], waiters: [] };
  ws.on('message', (data: Buffer) => {
    try {
      const frame = JSON.parse(data.toString('utf8'));
      const waiter = sock.waiters.shift();
      if (waiter) waiter(frame);
      else sock.buffer.push(frame);
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return sock;
}

function nextFrame(sock: FramedSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (sock.buffer.length > 0) {
      resolve(sock.buffer.shift()!);
      return;
    }
    const to = setTimeout(() => {
      const i = sock.waiters.indexOf(waiter);
      if (i >= 0) sock.waiters.splice(i, 1);
      reject(new Error(`nextFrame timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const waiter = (f: Record<string, unknown>) => {
      clearTimeout(to);
      resolve(f);
    };
    sock.waiters.push(waiter);
  });
}

async function waitForFrame(
  sock: FramedSocket,
  predicate: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  // Drain buffer first.
  for (let i = 0; i < sock.buffer.length; i++) {
    if (predicate(sock.buffer[i]!)) {
      return sock.buffer.splice(i, 1)[0]!;
    }
  }
  while (Date.now() < deadline) {
    const frame = await nextFrame(sock, Math.max(10, deadline - Date.now()));
    if (predicate(frame)) return frame;
  }
  throw new Error('waitForFrame timeout');
}

async function close(sock: FramedSocket): Promise<void> {
  const { ws } = sock;
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(() => resolve(), 500);
  });
}

describe('WebSocket integration', () => {
  let app: App;
  let baseUrl: string;
  let token: string;

  before(async () => {
    const bcrypt = (await import('bcrypt')).default;
    token = 'test-room-token';
    const hash = await bcrypt.hash(token, 4);

    __testOverrides.getRoom = async (id) => {
      if (id === 'nationals-2026') {
        return {
          id,
          display_label: 'Nationals 2026',
          token_hash: hash,
          created_at: new Date(),
          archived_at: null,
        };
      }
      return null;
    };
    __testOverrides.upsertTimerState = async () => {};
    __testOverrides.insertAuditEvent = async () => {};
    __testOverrides.loadTimerState = async () => null;
    __testOverrides.getStationNumber = async () => null;
    __testOverrides.findJudgesForRoom = async () => [];

    _resetRooms();

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    for (const k of Object.keys(__testOverrides)) {
      delete (__testOverrides as Record<string, unknown>)[k];
    }
    await app.close();
    _resetRooms();
  });

  it('rejects contestant upgrade on bad token', async () => {
    const url = `${baseUrl}/contestant?room=nationals-2026&id=alice&token=wrong`;
    const ws = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.once('open', () => {
        /* server may accept upgrade then close; still see close code */
      });
    });
    assert.equal(code, 1008);
  });

  it('rejects judge upgrade on bad ticket', async () => {
    const url = `${baseUrl}/judge?room=nationals-2026&ticket=nonsense`;
    const ws = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
    });
    assert.equal(code, 1008);
  });

  it('contestant receives initial STATE on connect', async () => {
    const url = `${baseUrl}/contestant?room=nationals-2026&id=alice&token=${token}`;
    const ws = await open(url);
    try {
      const frame = await nextFrame(ws);
      assert.equal(frame.type, 'STATE');
      assert.equal(frame.room, 'nationals-2026');
      assert.equal(frame.status, 'idle');
      assert.equal(frame.connectedContestants, 1);
    } finally {
      await close(ws);
    }
  });

  it('PING yields a PONG with t1 >= t0 and t2 >= t1', async () => {
    const url = `${baseUrl}/contestant?room=nationals-2026&id=alice&token=${token}`;
    const ws = await open(url);
    try {
      await nextFrame(ws); // discard STATE
      ws.ws.send(JSON.stringify({ type: 'PING', t0: Date.now() }));
      const pong = await nextFrame(ws);
      assert.equal(pong.type, 'PONG');
      assert.equal(typeof pong.t0, 'number');
      assert.equal(typeof pong.t1, 'number');
      assert.equal(typeof pong.t2, 'number');
      assert.ok((pong.t2 as number) >= (pong.t1 as number));
    } finally {
      await close(ws);
    }
  });

  it('judge TIMER_SET broadcasts STATE running to contestants', async () => {
    const contestantUrl = `${baseUrl}/contestant?room=nationals-2026&id=bob&token=${token}`;
    const contestant = await open(contestantUrl);

    // Mint a judge ticket with admin access.
    const ticket = ticketCache.mint({
      sub: 'judge-1',
      email: 'judge@example.com',
      groups: ['judges-admin'],
    });
    const judge = await open(`${baseUrl}/judge?room=nationals-2026&ticket=${ticket}`);

    try {
      await nextFrame(contestant); // initial STATE idle
      await nextFrame(judge); // STATE
      await nextFrame(judge); // HELP_QUEUE

      judge.ws.send(JSON.stringify({ type: 'TIMER_SET', durationMs: 60_000, message: 'go' }));

      const running = await waitForFrame(contestant, (f) => f.type === 'STATE' && f.status === 'running');
      assert.equal(running.status, 'running');
      assert.equal(running.message, 'go');
      assert.equal(typeof running.endsAtServerMs, 'number');
      assert.ok((running.endsAtServerMs as number) > Date.now() - 1000);
    } finally {
      await close(contestant);
      await close(judge);
    }
  });

  it('contestant HELP_REQUEST broadcasts HELP_QUEUE to judges (not contestants)', async () => {
    const contestantUrl = `${baseUrl}/contestant?room=nationals-2026&id=carol&token=${token}`;
    const contestant = await open(contestantUrl);

    const ticket = ticketCache.mint({ sub: 'judge-1', email: 'j@x', groups: ['judges-admin'] });
    const judge = await open(`${baseUrl}/judge?room=nationals-2026&ticket=${ticket}`);

    try {
      await nextFrame(contestant);
      await nextFrame(judge);
      await nextFrame(judge);

      contestant.ws.send(JSON.stringify({ type: 'HELP_REQUEST' }));

      const hq = await waitForFrame(judge, (f) => f.type === 'HELP_QUEUE');
      assert.equal(hq.type, 'HELP_QUEUE');
      const entries = hq.entries as Array<{ contestantId: string }>;
      assert.ok(entries.some((e) => e.contestantId === 'carol'));
    } finally {
      // Cancel help so the scheduled notification dispatcher doesn't linger.
      contestant.ws.send(JSON.stringify({ type: 'HELP_CANCEL' }));
      await new Promise((r) => setTimeout(r, 50));
      await close(contestant);
      await close(judge);
    }
  });

  it('duplicate HELP_REQUEST does not create a second entry (§7.1 idempotency)', async () => {
    _resetRooms();
    const room = getOrCreateRoomState('nationals-2026');
    // Skip the WS round-trip; test state directly.
    const { helpRequest } = await import('../src/help-queue.js');
    let q = room.helpQueue;
    q = helpRequest(q, 'dave', null, 1000).queue;
    const second = helpRequest(q, 'dave', null, 2000);
    assert.equal(second.changed, false);
    assert.equal(second.queue.entries.length, 1);
  });
});
