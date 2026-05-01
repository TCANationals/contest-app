import { describe, it, expect } from 'vitest';

import { buildContestantUrl, isLocalDevHost } from '../src/url';

describe('buildContestantUrl', () => {
  it('uses wss:// for production FQDNs', () => {
    const url = buildContestantUrl({
      roomKey: 'super-secret-room-key-abc',
      contestantId: 'alice',
      serverHost: 'timer.tcanationals.com',
    });
    expect(url).toBe(
      'wss://timer.tcanationals.com/contestant?key=super-secret-room-key-abc&id=alice',
    );
  });

  it('downgrades to ws:// for the docker-compose dev target', () => {
    // The compose file binds the server to localhost:3000 without
    // TLS — production-style wss:// would never connect, so this
    // downgrade is what makes `--server localhost:3000` work for the
    // overlay's docker-compose dev workflow.
    const url = buildContestantUrl({
      roomKey: 'dev-room-key-0123456789',
      contestantId: 'mike',
      serverHost: 'localhost:3000',
    });
    expect(url).toBe(
      'ws://localhost:3000/contestant?key=dev-room-key-0123456789&id=mike',
    );
  });

  it('downgrades to ws:// for 127.0.0.1 and IPv6 loopback', () => {
    expect(
      buildContestantUrl({
        roomKey: 'k-0123456789abcdef',
        contestantId: 'i',
        serverHost: '127.0.0.1:3000',
      }),
    ).toMatch(/^ws:\/\//);
    expect(
      buildContestantUrl({
        roomKey: 'k-0123456789abcdef',
        contestantId: 'i',
        serverHost: '[::1]:3000',
      }),
    ).toMatch(/^ws:\/\//);
  });

  it('URL-encodes special characters in query params', () => {
    const url = buildContestantUrl({
      roomKey: 'a b/c',
      contestantId: 'user@host',
      serverHost: 'timer.tcanationals.com',
    });
    expect(url).toContain('id=user%40host');
    // URLSearchParams encodes spaces as `+` and slashes as `%2F`.
    expect(url).toMatch(/key=a\+b%2Fc/);
  });
});

describe('isLocalDevHost', () => {
  it('matches loopback variants with and without port', () => {
    expect(isLocalDevHost('localhost')).toBe(true);
    expect(isLocalDevHost('LOCALHOST')).toBe(true);
    expect(isLocalDevHost('localhost:3000')).toBe(true);
    expect(isLocalDevHost('127.0.0.1')).toBe(true);
    expect(isLocalDevHost('127.0.0.1:8080')).toBe(true);
    expect(isLocalDevHost('::1')).toBe(true);
    expect(isLocalDevHost('[::1]:3000')).toBe(true);
  });

  it('rejects FQDNs and lookalikes', () => {
    expect(isLocalDevHost('timer.tcanationals.com')).toBe(false);
    expect(isLocalDevHost('localhost.attacker.example')).toBe(false);
    expect(isLocalDevHost('192.168.1.5')).toBe(false);
    expect(isLocalDevHost('127.1.0.1')).toBe(false);
  });
});
