// Contestant WebSocket URL builder (§5.1).
//
// Production servers are always TLS-terminated by Cloudflare, so the
// canonical URL uses `wss://`. For local dev the docker-compose server
// listens on `ws://localhost:3000` without TLS — `buildContestantUrl`
// transparently downgrades the scheme for known-loopback hosts so a
// developer can run `npm run tauri dev -- -- --server localhost:3000`
// against the dev stack without juggling TLS certs.
//
// The CSP in `src-tauri/tauri.conf.json` already whitelists
// `ws://localhost:*` and `ws://127.0.0.1:*` for exactly this reason.

export interface ContestantUrlInputs {
  room: string;
  contestantId: string;
  roomToken: string;
  serverHost: string;
}

export function buildContestantUrl(inputs: ContestantUrlInputs): string {
  const q = new URLSearchParams({
    room: inputs.room,
    id: inputs.contestantId,
    token: inputs.roomToken,
  });
  const scheme = isLocalDevHost(inputs.serverHost) ? 'ws' : 'wss';
  return `${scheme}://${inputs.serverHost}/contestant?${q.toString()}`;
}

/**
 * True when `host` looks like a local-dev target (`localhost`,
 * `127.0.0.1`, IPv6 loopback), with or without a `:port` suffix.
 * Production hosts are always FQDNs behind TLS, so anything else is
 * treated as `wss://`.
 *
 * We deliberately enumerate the accepted forms instead of stripping
 * a `:port` suffix with a regex — a naive port-strip would treat the
 * unbracketed IPv6 loopback `::1` as `:1` plus a "port" `:1`, which
 * is ambiguous, and would match `localhost.attacker.example:1234`
 * if we relaxed the prefix check.
 */
export function isLocalDevHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.startsWith('localhost:') ||
    h === '127.0.0.1' ||
    h.startsWith('127.0.0.1:') ||
    h === '[::1]' ||
    h.startsWith('[::1]:') ||
    h === '::1'
  );
}
