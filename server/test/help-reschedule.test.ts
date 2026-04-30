// Coverage for the scheduleHeadNotification re-arm path: when the head of
// the help queue leaves (self-cancel or judge ack) while other contestants
// are still waiting, a fresh 5-second notification debounce MUST be armed
// for the new head. Otherwise judges never get notified about the tail of
// the queue.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { __testOverrides } from '../src/db/dal.js';
import { getOrCreateRoomState, scheduleHeadNotification, _resetRooms } from '../src/rooms.js';
import { helpRequest, helpCancel, helpAck } from '../src/help-queue.js';

describe('scheduleHeadNotification (§7.4)', () => {
  before(() => {
    __testOverrides.insertAuditEvent = async () => {};
    __testOverrides.findJudgesForRoom = async () => [];
  });

  after(() => {
    delete __testOverrides.insertAuditEvent;
    delete __testOverrides.findJudgesForRoom;
    _resetRooms();
  });

  it('is idempotent when the head already has a pending job', () => {
    _resetRooms();
    const room = getOrCreateRoomState('room-1', 'Room One');
    room.helpQueue = helpRequest(room.helpQueue, 'alice', null, 1000).queue;
    scheduleHeadNotification(room);
    const firstJob = room.notifyJobs.get('alice');
    assert.ok(firstJob);
    // Second call should NOT replace the existing job.
    scheduleHeadNotification(room);
    assert.equal(room.notifyJobs.get('alice'), firstJob);
    firstJob?.cancel();
  });

  it('re-arms for the new head after the original head cancels', () => {
    _resetRooms();
    const room = getOrCreateRoomState('room-1', 'Room One');
    room.helpQueue = helpRequest(room.helpQueue, 'alice', null, 1000).queue;
    scheduleHeadNotification(room);
    room.helpQueue = helpRequest(room.helpQueue, 'bob', null, 1500).queue;

    // Alice cancels.
    room.helpQueue = helpCancel(room.helpQueue, 'alice').queue;
    const existing = room.notifyJobs.get('alice');
    existing?.cancel();
    room.notifyJobs.delete('alice');

    // Simulate the rooms-layer re-arm that both the contestant cancel
    // handler and the judge ack handler perform.
    if (room.helpQueue.entries.length > 0) {
      scheduleHeadNotification(room);
    }

    assert.ok(
      room.notifyJobs.has('bob'),
      'bob must have a scheduled notification after alice cancels',
    );
    room.notifyJobs.get('bob')?.cancel();
  });

  it('re-arms for the new head after a judge acks the original head', () => {
    _resetRooms();
    const room = getOrCreateRoomState('room-1', 'Room One');
    room.helpQueue = helpRequest(room.helpQueue, 'alice', null, 1000).queue;
    scheduleHeadNotification(room);
    room.helpQueue = helpRequest(room.helpQueue, 'bob', null, 1500).queue;

    const ackRes = helpAck(room.helpQueue, 'alice', room.helpQueue.version);
    assert.equal(ackRes.changed, true);
    room.helpQueue = ackRes.queue;
    room.notifyJobs.get('alice')?.cancel();
    room.notifyJobs.delete('alice');

    if (room.helpQueue.entries.length > 0) {
      scheduleHeadNotification(room);
    }

    assert.ok(
      room.notifyJobs.has('bob'),
      'bob must have a scheduled notification after alice is acked',
    );
    room.notifyJobs.get('bob')?.cancel();
  });

  it('does nothing when the queue is empty', () => {
    _resetRooms();
    const room = getOrCreateRoomState('room-1', 'Room One');
    scheduleHeadNotification(room);
    assert.equal(room.notifyJobs.size, 0);
  });
});
