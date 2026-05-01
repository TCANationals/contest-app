// Coverage for the immutable station-number update path in
// `handleHelpRequest`: when the async station-number lookup finds a
// value, the resulting HELP_QUEUE broadcast MUST carry a bumped version
// so version-deduping clients pick up the station-number change.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { buildServer } from '../src/index.js';
import { ticketCache } from '../src/auth/identity.js';
import { _resetRooms } from '../src/rooms.js';
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
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return sock;
}

async function waitForFrame(
  sock: FramedSocket,
  predicate: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Serve from the buffer first (in arrival order) so we don't strand
    // a non-matching earlier frame by jumping straight to waiters.
    if (sock.buffer.length > 0) {
      const frame = sock.buffer.shift()!;
      if (predicate(frame)) return frame;
      continue;
    }
    const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const to = setTimeout(() => {
        const idx = sock.waiters.indexOf(w);
        if (idx >= 0) sock.waiters.splice(idx, 1);
        reject(new Error('timeout'));
      }, Math.max(10, deadline - Date.now()));
      const w = (f: Record<string, unknown>) => {
        clearTimeout(to);
        resolve(f);
      };
      sock.waiters.push(w);
    }).catch(() => null);
    if (frame == null) break;
    if (predicate(frame)) return frame;
  }
  throw new Error('waitForFrame timeout');
}

async function close(sock: FramedSocket): Promise<void> {
  if (sock.ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    sock.ws.once('close', () => resolve());
    sock.ws.close();
    setTimeout(() => resolve(), 500);
  });
}

describe('HELP_QUEUE version bumps on station-number backfill', () => {
  let app: App;
  let baseUrl: string;
  let roomKey: string;

  before(async () => {
    roomKey = 'station-test-room-key-0123456789';

    const room = {
      id: 'nationals-2026',
      display_label: 'Nationals 2026',
      room_key: roomKey,
      created_at: new Date(),
      archived_at: null,
    };
    __testOverrides.getRoom = async (id) => (id === room.id ? room : null);
    __testOverrides.getRoomByKey = async (k) => (k === roomKey ? room : null);
    __testOverrides.upsertTimerState = async () => {};
    __testOverrides.insertAuditEvent = async () => {};
    __testOverrides.loadTimerState = async () => null;
    __testOverrides.findJudgesForRoom = async () => [];
    // Slow station-number lookup so we reliably see the
    // version-bumped follow-up broadcast.
    __testOverrides.getStationNumber = async (_room, contestantId) => {
      if (contestantId === 'alice') return 42;
      return null;
    };

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

  it('second HELP_QUEUE frame carries station number AND a higher version than the first', async () => {
    const ticket = ticketCache.mint({
      sub: 'judge-1',
      email: 'j@x',
      groups: ['judges-admin'],
    });
    const judge = await open(`${baseUrl}/judge?room=nationals-2026&ticket=${ticket}`);
    await waitForFrame(judge, (f) => f.type === 'STATE');
    await waitForFrame(judge, (f) => f.type === 'HELP_QUEUE');

    const contestant = await open(
      `${baseUrl}/contestant?key=${roomKey}&id=alice`,
    );
    // Wait for the contestant's initial STATE frame — that guarantees the
    // server's async route handler has finished attaching the `message`
    // listener, so our HELP_REQUEST isn't lost in the open-handshake race.
    await waitForFrame(contestant, (f) => f.type === 'STATE');

    try {
      contestant.ws.send(JSON.stringify({ type: 'HELP_REQUEST' }));

      // First HELP_QUEUE: station number is null (the sync mutation path
      // committed before the station lookup resolved).
      const firstQueue = await waitForFrame(
        judge,
        (f) =>
          f.type === 'HELP_QUEUE' &&
          Array.isArray(f.entries) &&
          (f.entries as Array<{ contestantId: string }>).some((e) => e.contestantId === 'alice'),
      );
      const firstEntry = (firstQueue.entries as Array<{ contestantId: string; stationNumber: number | null }>)
        .find((e) => e.contestantId === 'alice');
      assert.equal(firstEntry?.stationNumber, null);
      const firstVersion = firstQueue.version as number;

      // Second HELP_QUEUE: station number is filled in AND version is
      // strictly greater than the first. This locks down the Bugbot
      // finding — without the version bump the two frames would share
      // the same version and a client that dedupes on version would
      // miss the station number update.
      const secondQueue = await waitForFrame(
        judge,
        (f) =>
          f.type === 'HELP_QUEUE' &&
          Array.isArray(f.entries) &&
          (f.entries as Array<{ contestantId: string; stationNumber: number | null }>)
            .some((e) => e.contestantId === 'alice' && e.stationNumber === 42),
      );
      const secondVersion = secondQueue.version as number;
      assert.ok(
        secondVersion > firstVersion,
        `expected version to bump on station-number update; got ${firstVersion} -> ${secondVersion}`,
      );
    } finally {
      contestant.ws.send(JSON.stringify({ type: 'HELP_CANCEL' }));
      await new Promise((r) => setTimeout(r, 50));
      await close(contestant);
      await close(judge);
    }
  });
});
