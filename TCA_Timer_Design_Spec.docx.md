**Implementation Specification**

**TCA Timer & Help-Call System**

SkillsUSA Technical Computer Applications — Contest Environment

**Version:** v2.1 — implementation-ready

**Audience:** AI coding agents and human engineers building this system from scratch.

**Predecessors:** TCANationals/timer-desktop  •  TCANationals/timer-webapp — both deprecated and replaced wholesale by this spec.

**Date:** April 29, 2026

**Changes from v2.0:** station-map split into its own table; removed code-signing / SmartScreen / auto-update (deployed in trusted environment via golden image); GitHub Actions for CI; desktop window is fully non-interactive (no drag, no click events); desktop exposes a local HTTP control API and ships companion CLI helpers for desktop-shortcut actions; countdown digits get an inverse-color outline for guaranteed visibility on any background; new full-screen projector route on the SPA.

# **0\. How to read this document**

This is an implementation specification, not a design discussion. Every requirement is normative: **MUST**, **MUST NOT**, **SHOULD**, **MAY** carry RFC 2119 meanings. There are no "recommendations" — choices have been made.

**Document conventions:**

* **Identifiers in** monospace are exact strings: file paths, env var names, JSON keys, table/column names, HTTP paths. Use them verbatim.

* **Schemas** are authoritative. If prose and a schema disagree, the schema wins.

* **Cross-references** use §N.M notation (e.g., §6.3 \= section 6 subsection 3).

* **Times** in milliseconds are unix epoch ms unless stated otherwise.

* **"The server"** means the backend service in §11. "The desktop" means the contestant overlay in §9. "The SPA" means the judge web app in §10.

**Project layout the implementer SHOULD produce:**

| tca-timer/ ├── .github/ │   └── workflows/ │       ├── server.yml          \# build \+ test \+ deploy server (§14.1) │       ├── spa.yml             \# build \+ test SPA │       └── desktop.yml         \# cross-build Windows MSI artifact ├── server/             \# §11 — Node.js \+ Fastify \+ ws backend │   ├── src/ │   │   ├── index.ts            \# entry point, wires Fastify \+ WS │   │   ├── auth/ │   │   │   ├── cf-jwt.ts       \# CF Access JWT verification (§8.1) │   │   │   └── room-token.ts   \# contestant room-token verification (§8.2) │   │   ├── rooms.ts            \# in-memory RoomState map (§11.5) │   │   ├── timer.ts            \# timer state machine (§6.5) │   │   ├── help-queue.ts       \# help-queue state machine (§7) │   │   ├── notify/ │   │   │   ├── dispatcher.ts   \# debounce \+ auto-cancel logic (§7.4) │   │   │   ├── twilio.ts       \# SMS adapter │   │   │   └── ses.ts          \# AWS SES email adapter │   │   ├── db/ │   │   │   ├── schema.sql      \# exact DDL from §11.3 │   │   │   └── migrations/     \# node-pg-migrate files │   │   ├── ws/ │   │   │   ├── judge.ts        \# /judge endpoint handler │   │   │   └── contestant.ts   \# /contestant endpoint handler │   │   └── ratelimit.ts        \# per-conn token buckets (§6.4) │   ├── package.json │   └── railway.json ├── spa/                \# §10 — React \+ Vite judge web app │   ├── src/ │   │   ├── main.tsx │   │   ├── App.tsx │   │   ├── pages/ │   │   │   ├── Timer.tsx │   │   │   ├── Help.tsx │   │   │   ├── Log.tsx │   │   │   ├── Settings.tsx │   │   │   ├── Rooms.tsx │   │   │   └── Projector.tsx   \# full-screen view (§10.5) │   │   ├── components/ │   │   │   └── CountdownWithBorder.tsx  \# shared border renderer (§9.2.4) │   │   ├── hooks/ │   │   │   ├── useWebSocket.ts \# connection \+ reconnect (§6.4) │   │   │   └── useTimer.ts     \# offset \+ computeRemainingMs (§6.5) │   │   ├── store/      \# Zustand store │   │   └── pwa/ │   │       ├── manifest.webmanifest │   │       └── sw.ts │   ├── index.html │   ├── vite.config.ts │   └── package.json └── desktop/            \# §9 — Tauri 2 contestant overlay     ├── src/                \# frontend (TypeScript) — display only     ├── src-tauri/          \# Rust host     │   ├── src/     │   │   ├── main.rs         \# Tauri shell \+ window setup (§9.2)     │   │   └── ipc\_server.rs   \# local HTTP control API (§9.6)     │   ├── tauri.conf.json     │   └── Cargo.toml     ├── ctl/              \# tca-timer-ctl.exe — desktop shortcut CLI helper (§9.6.3)     │   ├── src/main.rs     │   └── Cargo.toml        \# GUI subsystem, minimal deps     └── package.json |
| :---- |

# **1\. Goals**

**The system MUST deliver three capabilities:**

1. **Synchronized countdown timer** visible to every contestant in a contest, controlled by judges, accurate to ±1 second across all clients regardless of local clock drift.

2. **Help-call queue** from contestants to judges, with bidirectional dismissal (contestant self-cancel or judge acknowledge).

3. **Multi-room concurrency** so one backend deployment serves multiple parallel contests without state leakage between them.

**Operational requirements:**

* Desktop overlay MUST auto-launch at Windows 11 login and run unattended for an entire contest day.

* Judge SPA MUST be usable on a phone, one-handed, while walking the contest floor.

* Backend MUST run on Railway with managed Postgres.

* Client-to-server traffic MUST traverse the public internet (assume 50–100 ms RTT) without abusing the server.

* Optional SMS (Twilio) and email (AWS SES) notifications MUST be available per judge.

## **1.1 Non-goals**

* Contestant authentication beyond OS session trust \+ per-room token.

* Per-judge user management (Cloudflare Access is the identity provider).

* Mobile contestant clients (contestants compete on the VM only).

* Hardware indicators (BlinkStick or similar) — explicitly removed from the legacy system.

* Macros, scripting, multi-day persistence of timer state across contests.

# **2\. System overview**

**Three components, one backend, one database:**

* **Desktop overlay** (§9) — a Tauri 2 app installed in each contestant VM. Displays the countdown, the help-call button, and contestant-local preferences. Connects to the backend via WebSocket.

* **Judge SPA** (§10) — a React PWA served from the backend's origin behind Cloudflare Access. Connects to the backend via WebSocket. Mobile-first.

* **Backend service** (§11) — a Node.js \+ Fastify \+ ws server hosted on Railway. Holds authoritative timer/help-queue state per room in memory; persists state and audit log to Railway-managed Postgres. Dispatches optional SMS via Twilio and email via AWS SES.

| ┌────────────────────────┐         ┌────────────────────────────┐ │   Contestant VM        │         │     Judge phone/laptop     │ │  ┌──────────────────┐  │         │  ┌──────────────────────┐  │ │  │ Desktop Overlay  │  │         │  │  Browser              │  │ │  │ (Tauri 2 \+ Rust) │  │         │  │  Judge SPA (PWA)     │  │ │  └────────┬─────────┘  │         │  └──────────┬───────────┘  │ └───────────┼────────────┘         └─────────────┼──────────────┘   WSS /contestant?room=…\&id=…\&token=…  WSS /judge?room=…\&ticket=…             │                                    │             ▼                                    ▼         ┌──────────────────────────────────────────────┐         │     Cloudflare (Tunnel \+ Access on /judge\*)  │         └──────────────────────┬───────────────────────┘                                ▼                     ┌──────────────────────┐         ┌──────────────┐                     │  Backend (Railway)   │ ◀─────▶│ Twilio (SMS) │                     │  Node 22 \+ Fastify   │         └──────────────┘                     │  \+ ws library        │         ┌──────────────┐                     │                      │ ◀─────▶│ AWS SES      │                     │  per-room state in   │         │ (email)      │                     │  memory; durable in  │         └──────────────┘                     │  Postgres            │                     └──────────┬───────────┘                                ▼                     ┌──────────────────────┐                     │  Postgres (Railway)  │                     │  rooms, timer\_state, │                     │  judge\_prefs,        │                     │  audit\_log           │                     └──────────────────────┘ |
| :---- |

# **3\. Identity model**

**The system has exactly two principal types.**

## **3.1 Contestant**

* **Identifier:** the OS username of the logged-in Windows session, lowercased.

* **Format:** \[a-z0-9.\_-\]{1,32}. Server MUST reject WebSocket upgrades whose id parameter does not match this regex.

* **Scope:** unique within a room only. Two rooms MAY each have a contestant ID contestant-07.

* **Authentication:** OS session trust \+ per-room token (§8.2). The contestant ID itself is not authenticated.

## **3.2 Judge**

* **Identifier:** the sub claim from the Cloudflare Access JWT. This is a stable opaque string assigned by Cloudflare's identity layer.

* **Display name:** the email claim from the same JWT, used in audit logs and UI.

* **Authentication:** Cloudflare Access JWT (§8.1).

| MUST: identify judges by sub, never by email Persistent records MUST key on the JWT sub claim. Email addresses change (name changes, employer changes); sub does not. Specifically: |
| :---- |

* **The** judge\_prefs Postgres table (§11.3) MUST use sub as its primary key, not email.

* Audit log entries (§11.3 audit\_log.actor\_sub) MUST store sub as the canonical actor; the email at the time of the event is stored alongside in audit\_log.actor\_email for human readability.

* WebSocket tickets (§8.1) MUST carry the sub and bind the ticket to it.

* UI surfaces SHOULD show the email; backend records MUST NOT key on it.

# **4\. Rooms**

**A room is the unit of isolation.** Each room has its own timer, its own help queue, its own audit log, its own contestant token. Cross-room state leakage is impossible by construction: connections are scoped to a room at the URL level and the server's in-memory state is keyed on room ID.

## **4.1 Room identifier format**

* **Regex:** ^\[a-z0-9\]\[a-z0-9-\]{1,62}$ (DNS-style; first character alphanumeric).

* **Examples:** nationals-2026, region-3-spring, practice-2026-09-14.

* **Stable for the lifetime of the room.** Renames MUST NOT be supported. Archive-and-recreate instead.

## **4.2 Room provisioning**

1. Admin calls POST /api/admin/rooms (§11.2) with a JSON body containing id and display\_label.

2. Server generates a 256-bit cryptographically random **room token**, returns it once in the response, and stores only its bcrypt hash in rooms.token\_hash.

3. Admin captures the token from the response and bakes it into the contestant VM golden image alongside the room ID (§9.4).

4. Token rotation: POST /api/admin/rooms/:id/rotate-token generates a new token, returns it once, and updates the hash. Active connections are NOT terminated; only new connections require the new token.

# **5\. Wire protocol**

All client–server traffic uses a single WebSocket per client. JSON frames, UTF-8 encoded. Each frame MUST have a type field; all other fields depend on the type.

## **5.1 Connection URLs**

| Judge:      wss://timer.example.com/judge?room=\<roomId\>\&ticket=\<ticket\> Contestant: wss://timer.example.com/contestant?room=\<roomId\>\&id=\<username\>\&token=\<roomToken\> |
| :---- |

**Server MUST reject the WebSocket upgrade if:**

* the room does not exist or is archived;

* for /judge, the ticket is missing/expired/invalid or its groups claim does not include the requested room (see §8.1);

* for /contestant, the token does not match the room's hash, or the id fails the regex in §3.1;

* the per-IP connection rate limit (§6.4) is exhausted;

* the room's connection cap (§6.4) is reached.

On rejection, the server MUST return an HTTP 4xx status (401 for auth failures, 403 for room-access failures, 429 for rate-limit, 404 for unknown room) before the WebSocket handshake completes.

## **5.2 Frame catalog**

| Direction | type | Payload schema | Notes |
| :---- | :---- | :---- | :---- |
| client → server | PING | { t0: number } | Time-sync request (§6). |
| server → client | PONG | { t0, t1, t2 } | Immediate reply; t1=receive, t2=send. |
| server → client | STATE | TimerState (§6.5) | On connect; on every state change. |
| server → client | HELP\_QUEUE | HelpQueue (§7.3) | Judges only. On connect; on every queue change. |
| server → client | ERROR | { code, message } | Server-side error before close (e.g., rate-limit warning). |
| judge → server | TIMER\_SET | { durationMs, message? } | Sets timer to running with given duration. |
| judge → server | TIMER\_PAUSE | {} | Running → paused. |
| judge → server | TIMER\_RESUME | {} | Paused → running. |
| judge → server | TIMER\_ADJUST | { deltaMs: number } | Add (positive) or subtract (negative) ms from running/paused timer. |
| judge → server | TIMER\_RESET | {} | Any state → idle. |
| judge → server | HELP\_ACK | { contestantId } | Removes that entry from the queue. |
| contestant → server | HELP\_REQUEST | {} | Adds caller to queue. Idempotent. |
| contestant → server | HELP\_CANCEL | {} | Removes caller from queue. Idempotent. |

# **6\. Synchronized timer**

## **6.1 Functional requirements**

* **Set:** a judge specifies a duration in ms; all clients begin counting down within 500 ms (95th percentile end-to-end).

* **Pause / Resume / Adjust / Reset:** as defined in §5.2.

* **Drift accuracy:** every client's displayed remaining time MUST match the server's authoritative remaining time within ±1 second, regardless of the client's local clock skew.

* **Resilience:** a client whose WebSocket drops and reconnects MUST resume display without a visible jump \>2 seconds.

* **Persistence:** server restart MUST NOT change the displayed time on any reconnecting client by more than 2 seconds.

## **6.2 Why client wall clocks cannot be trusted**

VMs that hibernate, have NTP disabled by group policy, or experience hypervisor clock steps can show wall-clock drift of seconds to minutes. The system MUST NOT compute remaining time as endTime \- Date.now() against the client's wall clock. Instead, clients track an **offset** against the server's authoritative clock and apply it to every render.

## **6.3 Time-sync protocol**

**Client behavior:**

1. On WebSocket connect, send a **warm-up burst** of 4 PING frames spaced 1 second apart.

2. After the burst, send 1 PING every 30 seconds for the lifetime of the connection.

3. On each PONG, compute round-trip and offset using the formulas below. Maintain a sliding window of the last 8 (round-trip, offset) samples.

4. Drop the 2 samples with the largest round-trip. Use the median offset of the remaining 6 as the active offset.

5. Render every 250 ms (4 Hz internal); the visible display updates at 1 Hz.

**Computation:**

| // Client side, on receiving PONG with original t0 and server's t1, t2: const t3 \= Date.now(); const roundTrip \= (t3 \- t0) \- (t2 \- t1); const offset    \= ((t1 \- t0) \+ (t2 \- t3)) / 2; // Append { roundTrip, offset } to the sliding window of size 8\. // Drop 2 worst by roundTrip; median of remaining 6 offsets is the active offset.   // Computing remaining time on every render: function computeRemainingMs(state: TimerState, activeOffsetMs: number): number {   if (state.status \=== 'paused') return state.remainingMs;   if (state.status \=== 'idle')   return 0;   // running:   const serverNow \= Date.now() \+ activeOffsetMs;   return Math.max(0, state.endsAtServerMs \- serverNow); } |
| :---- |
| **MUST: server streams endpoints, never remaining seconds** STATE frames MUST contain endsAtServerMs (for running) or remainingMs (for paused), never a continuously-updating "current remaining" value. The server MUST NOT broadcast on a timer interval; it broadcasts only on state transitions. Clients compute remaining time locally on every render frame. |

## **6.4 Server load budget & abuse prevention**

**Per-connection rate limits** (token-bucket; server SHOULD silently drop excess frames, then close with code 1008 if the abuse threshold is reached):

| Frame type | Steady-state rate | Hard cap | Abuse threshold |
| :---- | :---- | :---- | :---- |
| PING | 2/min | 10/min | 100 dropped in 5 min → close |
| HELP\_REQUEST | \<1/min | 6/min | 20 dropped in 5 min → close |
| HELP\_CANCEL | \<1/min | 6/min | 20 dropped in 5 min → close |
| TIMER\_\* | varies | 60/min | 120 dropped in 5 min → close |
| HELP\_ACK | varies | 60/min | 120 dropped in 5 min → close |

**Per-source-IP limits:**

* **New connections:** 30/min, token-bucket. Excess return HTTP 429\.

* **Total room connections:** 200 hard cap (per room).

**Server-side housekeeping:**

* **Application heartbeat:** server MUST close any client connection that has not sent a PING in 90 seconds.

* **Reconnect backoff (client-side):** exponential with full jitter — base delays 1, 2, 4, 8, 16 s, capped at 30 s; reset on successful connection.

## **6.5 Timer state model**

**Server-authoritative state, one per room:**

| type TimerStatus \= 'idle' | 'running' | 'paused';   interface TimerState {   room:              string;       // room id; matches connection scope   version:           number;       // monotonically increasing per room   status:            TimerStatus;   endsAtServerMs:    number | null; // set iff status \=== 'running'   remainingMs:       number | null; // set iff status \=== 'paused'   message:           string;        // optional banner, '' when unset   setBySub:          string;        // judge JWT sub of last writer   setByEmail:        string;        // judge email at write time (display only)   setAtServerMs:     number;        // server unix ms of last write } |
| :---- |

**State transition rules** (server MUST enforce; invalid transitions return an ERROR frame and ignore the command):

| Current status | Command | Result | Effect |
| :---- | :---- | :---- | :---- |
| idle | TIMER\_SET | running | endsAtServerMs \= now \+ durationMs; version++ |
| idle | TIMER\_PAUSE | ERROR | no-op |
| idle | TIMER\_RESUME | ERROR | no-op |
| idle | TIMER\_ADJUST | ERROR | no-op |
| running | TIMER\_SET | running | replaces endsAtServerMs; version++ |
| running | TIMER\_PAUSE | paused | remainingMs \= max(0, endsAtServerMs \- now); version++ |
| running | TIMER\_ADJUST | running | endsAtServerMs \+= deltaMs; version++ |
| running | TIMER\_RESET | idle | endsAtServerMs \= null; version++ |
| paused | TIMER\_RESUME | running | endsAtServerMs \= now \+ remainingMs; version++ |
| paused | TIMER\_ADJUST | paused | remainingMs \= max(0, remainingMs \+ deltaMs); version++ |
| paused | TIMER\_RESET | idle | remainingMs \= null; version++ |
| paused | TIMER\_SET | running | replaces with new duration; version++ |
| any | TIMER\_RESET | idle | version++ |

# **7\. Help-call system**

## **7.1 Contestant button states**

| State | Label | Visual | Click sends |
| :---- | :---- | :---- | :---- |
| idle | Call Judge | Default color | HELP\_REQUEST |
| pending | Cancel Request | Amber | HELP\_CANCEL |

**Transitions:**

* idle → pending: contestant clicks the button. Server adds them to the queue; broadcasts updated HELP\_QUEUE; this client's button shows pending.

* pending → idle (self-cancel): contestant clicks again. Server removes from queue; broadcasts; button reverts.

* pending → idle (judge ack): a judge presses Acknowledge. Server removes from queue; broadcasts. The contestant's desktop SHOULD show a 3-second toast "Judge acknowledged" before reverting.

* Idempotency: HELP\_REQUEST when already pending is a no-op (no second queue entry, no audit-log row beyond the original). HELP\_CANCEL when not in queue is a no-op.

## **7.2 Judge queue display**

* Sorted oldest-first by requestedAtServerMs.

* Each row shows: contestant ID, station number (if mapped via §11.3 station\_assignments table), live wait-time counter, Acknowledge button.

* Audible chime (the existing ding.mp3 asset) when queue transitions from empty to non-empty. Subsequent additions to a non-empty queue MUST NOT chime.

* Contestant self-cancel MUST NOT play any sound or banner — the row simply disappears on the next HELP\_QUEUE broadcast.

* First-judge-wins on Acknowledge: server compares the queue version on the incoming HELP\_ACK; mismatched versions are no-ops.

## **7.3 HelpQueue schema**

| interface HelpQueue {   room:    string;   version: number;   entries: Array\<{     contestantId:        string;       // OS username, lowercased     stationNumber:       number | null;     requestedAtServerMs: number;   }\>;  // sorted ascending by requestedAtServerMs } |
| :---- |

## **7.4 Notification dispatch (SMS \+ email)**

When a HELP\_REQUEST causes the queue to transition from empty to non-empty in a room, the server MUST evaluate notification dispatch for every judge whose preferences (§11.3 judge\_prefs) meet ALL of these conditions:

* the judge has at least one of SMS or email enabled with a verified address;

* the room is in their enabled\_rooms array;

* the current time in their timezone is NOT within their configured quiet hours;

* they have not acknowledged a help-call in this room within the last 30 seconds (per-judge debounce);

* their phone\_status / email\_status is verified (not opted\_out).

### **7.4.1 Dispatch worker**

1. On qualifying queue transition, server enqueues a notification job with a 5-second delay.

2. After 5 seconds, the worker re-checks the queue. If the original requester is no longer in the queue (cancelled or acknowledged), the job is **dropped** with no notification sent. An audit-log row NOTIFY\_DROPPED is written.

3. Otherwise, the worker sends SMS via Twilio (§7.4.2) and/or email via SES (§7.4.3) to every qualifying judge in parallel.

4. Outcome of each send is logged: SMS\_SENT, SMS\_FAILED, EMAIL\_SENT, EMAIL\_FAILED in the audit log.

5. Send failures are retried exactly once after 10 seconds. Second failures are logged and abandoned. WebSocket broadcast is NEVER blocked on notification dispatch.

### **7.4.2 SMS via Twilio**

* **Service:** Twilio Programmable Messaging.

* **SDK:** the official twilio Node package.

* **Required env vars:** TWILIO\_ACCOUNT\_SID, TWILIO\_AUTH\_TOKEN, TWILIO\_FROM\_NUMBER (E.164).

* **Phone format:** E.164 (e.g., \+15555550123). Server MUST validate before storing.

* **Verification:** on phone-number set or change, generate a 6-digit OTP code, store its hash in judge\_prefs.pending\_phone\_code\_hash, set phone\_status='pending', expire in 10 minutes, send via Twilio. Confirmation via POST /api/judge/prefs/verify-phone with the code.

* **Opt-out:** Twilio's STOP keyword handling is enabled at the carrier level. The server MUST listen on a Twilio status webhook (POST /api/webhooks/twilio, with HMAC signature validation) and transition phone\_status to opted\_out when an unsubscribe is reported.

* **Message body:** "*Help requested in \<display\_label\> by contestant \<id\>*" — keep under 160 characters total.

### **7.4.3 Email via AWS SES**

* **Service:** AWS Simple Email Service (SES) v2.

* **SDK:** the official @aws-sdk/client-sesv2 package (AWS SDK for JavaScript v3).

* **Required env vars:** AWS\_ACCESS\_KEY\_ID, AWS\_SECRET\_ACCESS\_KEY, AWS\_REGION, SES\_FROM\_ADDRESS (a verified SES sender identity), SES\_CONFIGURATION\_SET (for engagement tracking and bounce/complaint routing).

* **API call:** SendEmailCommand with a Content.Simple body — plain text, no HTML.

* **Verification:** same OTP pattern as phone verification, stored in judge\_prefs.pending\_email\_code\_hash. The user-facing email address is verified independently of the SES sender identity.

* **Bounces & complaints:** server MUST subscribe to SES bounce/complaint events via SNS → HTTPS endpoint POST /api/webhooks/ses (with SNS signature validation). On a hard bounce or complaint, transition email\_status to opted\_out.

* **Subject:** "*Help request in \<display\_label\>*".

* **Body:** "*Contestant \<id\> requested help in \<display\_label\> at \<local time\>. Open the dashboard: \<SPA URL\>?room=\<roomId\>*".

* **List-Unsubscribe header:** MUST include List-Unsubscribe: \<mailto:…\>, \<https://…\> and List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058\) so providers honor unsubscribes natively.

### **7.4.4 Per-judge preferences (overview; schema in §11.3)**

* **phone\_e164** — null disables SMS.

* **phone\_status** — none | pending | verified | opted\_out.

* **email\_address** — null disables email; default value MAY be the JWT email but MUST be re-verified before use.

* **email\_status** — none | pending | verified | opted\_out.

* **enabled\_rooms** — TEXT\[\]; empty \= disabled, listed \= enabled. SMS and email use the same allow-list.

* **quiet\_hours\_start**, quiet\_hours\_end — TIME values. End may be earlier than start to indicate an overnight window. Both null \= no quiet hours.

* **quiet\_hours\_weekdays** — SMALLINT bitmask: bit 0 Sun … bit 6 Sat. 0 \= quiet hours never apply.

* **timezone** — IANA name (e.g., America/Chicago). Required when quiet hours set.

# **8\. Authentication**

## **8.1 Judge — Cloudflare Access**

**Setup (operator-side, not implemented in code):**

* Create a Cloudflare Access application protecting the SPA origin and the /api/judge/\* path.

* Create one Access group per room, named judges-\<roomId\>. Create one judges-admin group for cross-room admins.

* Configure each room's group with its IdP rule set.

**Server-side JWT verification:**

* Cloudflare attaches the JWT as the Cf-Access-Jwt-Assertion header and as a CF\_Authorization cookie.

* Verify against Cloudflare's JWKS at https://\<team\>.cloudflareaccess.com/cdn-cgi/access/certs, cached for 1 hour.

* Required claim checks: aud matches CF\_ACCESS\_AUD env var; exp not expired; iss matches CF\_ACCESS\_ISSUER env var.

* Extract: sub (canonical judge ID), email (display name), groups (string array, used for room access).

**Ticket-mint flow** (WebSocket cookies are unreliable across browsers; tickets bridge the gap):

1. SPA calls POST /api/judge/ticket with the CF cookie attached. Server verifies the JWT.

2. Server generates a 256-bit random ticket, stores { ticket → { sub, email, groups, expires\_at } } in an in-memory LRU cache with a 30-second TTL.

3. Server returns the ticket as JSON; SPA opens WSS /judge?room=…\&ticket=….

4. On WebSocket upgrade, server looks up the ticket. If valid AND room ∈ groups (or judges-admin ∈ groups), accept the upgrade. Tickets are single-use: the server MUST delete the ticket from the cache on successful upgrade.

**Group → room access mapping:**

| function judgeRoomAccess(groups: string\[\]): 'all' | string\[\] {   if (groups.includes('judges-admin')) return 'all';   return groups     .filter(g \=\> g.startsWith('judges-'))     .map(g \=\> g.slice('judges-'.length)); } |
| :---- |

## **8.2 Contestant — OS session \+ room token**

**Trust model:** the contestant VM is contest-controlled. The OS-reported username is the contestant ID. The room token authenticates the venue, not the person.

**Connection parameters:**

* **room** — from §9.4 resolution chain.

* **id** — os.userInfo().username.toLowerCase(), validated against §3.1 regex.

* **token** — from §9.4 resolution chain.

**Server validation:**

* Constant-time bcrypt compare against rooms.token\_hash.

* Failure returns HTTP 401 before the upgrade completes.

* Token rotation: in-flight connections continue with the old token; new connections after rotation require the new token.

**Threat model:** a leaked token grants WebSocket access to one room's STATE broadcasts and the ability to enqueue rate-limited help-call noise. It does NOT permit setting the timer or impersonating a judge. Token leakage is mitigated by rotation between contests.

# **9\. Desktop application**

## **9.1 Stack**

* **Framework:** Tauri 2.x (Rust host \+ system WebView).

* **Frontend:** TypeScript \+ React 18; Vite for build.

* **Target:** Windows 11 x64. The build MUST produce an unsigned MSI installer (no code signing required — the environment is trusted).

* **Build CI:** GitHub Actions workflow on the public CI infrastructure. On push to main or on tag creation, build the MSI artifact and attach it to the GitHub Release. The workflow MUST use tauri-apps/tauri-action for the build matrix.

* **No auto-update.** Deployments are manual: new builds are baked into the VM golden image. The Tauri updater MUST be disabled in tauri.conf.json.

## **9.2 Window behavior**

| Property | Value |
| :---- | :---- |
| Default size | 380 × 96 px |
| Default position | Bottom-right of primary display, 24 px margin from work-area edges |
| Frameless | Yes |
| Transparent background | Yes |
| Always on top | Yes (Tauri level: \`always\_on\_top\` true) |
| Non-interactive | The overlay window MUST ignore ALL mouse events (click, hover, drag, scroll). It is purely visual. There is no grip, no drag handle, no clickable surface. All interaction happens via the system tray or desktop shortcuts (§9.6). |
| Skip taskbar | Yes |
| Resizable | No (size locked) |
| Position control | System tray menu only: four options (TL/TR/BL/BR) reposition the window to the selected corner with 24 px margin. No free-form dragging. |
| Multi-monitor | Subscribes to display events; if the active display disappears, reposition to primary display's configured corner. |
| System tray | Show / Hide / Position → (TL/TR/BL/BR) / Preferences / Quit (with confirm) |

**Contrast border:** the countdown display MUST render a high-contrast border around the time text to ensure visibility against any screen content. Border color MUST be the perceptual opposite of the text color:

* Green text (\#16A34A) → black border (\#000000).

* Amber text (\#F59E0B) → dark navy border (\#1A1A2E).

* Red text (\#DC2626) → white border (\#FFFFFF).

* Idle gray text (\#888888) → black border (\#000000).

* Paused white text → black border (\#000000).

The border MUST be at least 2 px wide and applied as a stroke/outline on the text glyphs, not as a box border. This ensures the digits are readable whether over a white document, a dark IDE, or a busy desktop wallpaper.

**Countdown display** (in priority order):

* **idle** → "--:--" in muted gray (\#888888 over transparent).

* **paused** → time in white with "PAUSED" pill underneath.

* **running, \> 5 minutes left** → green (\#16A34A).

* **running, 1–5 minutes left** → amber (\#F59E0B).

* **running, \< 1 minute left** → red (\#DC2626) with 1 Hz pulse.

* **Format**: MM:SS under 60 minutes; H:MM:SS otherwise.

* **Font**: large monospaced digits, JetBrains Mono or system monospace fallback.

## **9.3 Auto-launch & single instance**

* Installer MUST register auto-launch via HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run with name TCATimer.

* App MUST acquire a single-instance lock at startup; second-instance launches MUST exit immediately.

## **9.4 Configuration resolution**

**At launch, the desktop MUST resolve** room and roomToken by checking these sources in order. First non-empty match wins.

| Priority | Source | Keys |
| :---- | :---- | :---- |
| 1 | Command-line flags | \--room \<id\> \--room-token \<token\> |
| 2 (production) | Windows registry | HKLM\\Software\\TCANationals\\Timer\\Room and \\RoomToken (REG\_SZ) |
| 3 | Config file | %PROGRAMDATA%\\TCATimer\\config.json with keys 'room' and 'roomToken' |
| 4 | Environment variables | TCA\_TIMER\_ROOM, TCA\_TIMER\_ROOM\_TOKEN |

**If no source resolves both values:**

* Display "Configuration error: no room assigned" in the overlay window in red.

* Set tray-icon tooltip to list each tried source and its result.

* Do NOT attempt to connect.

**Golden image provisioning command** (executed during VM image authoring, e.g., from Packer):

| reg add HKLM\\Software\\TCANationals\\Timer /v Room /t REG\_SZ /d \<roomId\> /f reg add HKLM\\Software\\TCANationals\\Timer /v RoomToken /t REG\_SZ /d \<token\> /f |
| :---- |

## **9.5 Local preferences**

**Storage:** %USERPROFILE%\\.tcatimer\\preferences.json. Atomic writes (write to a temp file in the same directory, fsync, rename). Created with defaults if missing. Schema-versioned.

| // preferences.json (version 1\) {   "version": 1,   "alarm": {     "enabled": true,     "volume": 0.6              // 0.0 \- 1.0   },   "flash": {     "enabled": false,     "thresholdMinutes": 2.0    // valid range: 0.5 \- 30.0   },   "position": {     "corner": "bottomRight"   // bottomRight | bottomLeft | topRight | topLeft   },   "hidden": false } |
| :---- |

### **9.5.1 End-of-timer alarm**

* Triggered when the timer transitions from running to a remaining time of 0 (i.e., at the moment computeRemainingMs first returns 0 in the running state).

* Plays the bundled asset alarm.wav (distinct from the SPA's ding.mp3).

* Volume from preferences.alarm.volume.

* Capped at 4 seconds of playback per fire.

* MUST NOT re-fire within 30 seconds of a prior fire (handles paused-then-resumed-past-zero).

* If preferences.alarm.enabled \=== false, do nothing.

### **9.5.2 Configurable flash**

* If preferences.flash.enabled \=== true and remaining time ≤ thresholdMinutes \* 60\_000 ms while running, the countdown display flashes between its current color (per §9.2 priorities) and the overlay's transparent background at 1 Hz.

* Flashing stops on transition to idle or paused, or when remaining time exceeds the threshold (after a TIMER\_ADJUST that adds time).

* Flashing is INDEPENDENT of the green/amber/red color states — both apply.

### **9.5.3 Preferences error handling**

* Missing file: create with defaults.

* Unparseable JSON: log a warning, fall back to in-memory defaults, do NOT overwrite the bad file (preserve for diagnostics).

* Older version: run an in-place migration to current version.

* Newer version (downgrade scenario): use defaults, log a warning.

* Write failures: surface a tray-icon warning; runtime continues with in-memory state.

## **9.6 Desktop shortcuts & IPC interface**

The overlay window is non-interactive (§9.2). All user actions — requesting help, canceling a request, showing/hiding the timer — MUST be triggerable from **desktop shortcuts** that the golden image places on the contestant's desktop. The desktop app exposes a **local HTTP API** on a fixed localhost port that these shortcuts call via a bundled helper.

### **9.6.1 Local HTTP server**

* **Bind address:** 127.0.0.1:17380. Loopback only — not reachable from the network.

* **No auth required** — any process on the local machine can call it. This is acceptable because the VM is single-user and contest-controlled.

* **Startup:** the local HTTP server MUST start before the WebSocket connection to the backend, so shortcuts work even if the network is momentarily down (help-request will queue locally and send when connected).

### **9.6.2 Endpoints**

| Method \+ path | Effect | Response |
| :---- | :---- | :---- |
| POST /help/request | If not already in queue, sends HELP\_REQUEST to the backend. If offline, queues it for send on reconnect. | 200 OK \+ { status: 'requested' | 'already\_pending' | 'queued\_offline' } |
| POST /help/cancel | If currently pending, sends HELP\_CANCEL to the backend. | 200 OK \+ { status: 'cancelled' | 'not\_pending' } |
| POST /timer/show | Shows the overlay window. | 200 OK \+ { visible: true } |
| POST /timer/hide | Hides the overlay window. | 200 OK \+ { visible: false } |
| POST /timer/toggle | Toggles overlay visibility. | 200 OK \+ { visible: boolean } |
| GET /status | Returns current state: timer status, help-call status, visibility, connection status. | 200 OK \+ { timer: TimerState | null, helpPending: boolean, visible: boolean, connected: boolean } |

### **9.6.3 Desktop shortcuts**

The installer (or golden-image provisioning script) MUST place these shortcuts on the contestant's desktop. Each is a simple .lnk file that invokes the bundled CLI helper:

| \# The CLI helper is installed alongside the main app binary: \# %PROGRAMFILES%\\TCATimer\\tca-timer-ctl.exe   \# Desktop shortcuts (created by installer / provisioning script): "Call Judge"    → tca-timer-ctl.exe help request "Cancel Help"   → tca-timer-ctl.exe help cancel "Show Timer"    → tca-timer-ctl.exe timer show "Hide Timer"    → tca-timer-ctl.exe timer hide |
| :---- |

**tca-timer-ctl.exe** is a minimal compiled binary (\~500 KB) that:

* Parses the subcommand (help request, help cancel, timer show, timer hide).

* Makes a single HTTP POST to http://127.0.0.1:17380/\<path\>.

* Displays a brief Windows toast notification with the result ("Help requested", "Help cancelled", etc.) using the OS notification API. No console window should flash.

* If the main app is not running (connection refused), shows a toast: "TCA Timer is not running."

* Exits immediately after the toast. Total runtime \< 500 ms.

The CLI helper MUST be built as a Windows GUI subsystem binary (/SUBSYSTEM:WINDOWS or equivalent) so no console window flashes when a shortcut is clicked. It SHOULD be a small Rust binary compiled alongside the main Tauri app in the same workspace.

## **9.7 Reconnection**

On WebSocket close (any reason), the desktop MUST:

1. Continue rendering the countdown using the last-known TimerState and the active offset (the offset is frozen but not invalidated).

2. Dim the overlay's opacity to 0.7 to indicate stale data.

3. Reconnect using exponential backoff with full jitter: base 1, 2, 4, 8, 16 s, capped at 30 s. Reset to 1 s on successful reconnect.

4. On reconnect, restore opacity to 1.0 and resume normal time-sync (warm-up burst followed by 30 s cadence per §6.3).

5. If a HELP\_REQUEST was queued locally (via the /help/request endpoint while disconnected), send it on reconnect.

## **9.8 Hardening**

* CSP: default-src 'self'; connect-src wss://timer.example.com http://127.0.0.1:17380; style-src 'self' 'unsafe-inline'. No remote scripts or fonts.

* No file system access beyond the state directory and the preferences file in §9.5.

* No remote URL loading. The legacy app's loadURL pattern MUST NOT be used.

# **10\. Judge web application**

## **10.1 Stack**

* **Build:** Vite 5.x.

* **Framework:** React 18.x with TypeScript 5.x.

* **State:** Zustand 4.x. No MobX, no decorators, no Redux.

* **Server queries:** TanStack Query 5.x for the REST surface (ticket, prefs, audit log).

* **Styling:** Tailwind CSS 3.x.

* **Routing:** React Router 6.x.

* **PWA:** Vite PWA plugin; service worker MUST cache the app shell for offline display of the most recent state.

## **10.2 Screens**

| Path | Purpose |
| :---- | :---- |
| / | Auto-redirect: if no ?room and judge has access to one room, route to that room's Timer screen. Multiple rooms → /rooms. |
| /rooms | Room picker. Lists rooms from /api/judge/rooms in MRU order (last-visited rooms first); fall back to alphabetical for never-visited. |
| /?room=… | Timer screen for selected room. |
| /help?room=… | Help-queue screen for selected room. |
| /log?room=… | Audit-log screen; CSV export button. Admins MAY pass \&all=1 for cross-room view. |
| /settings?room=… | Settings: personal SMS/email prefs (account-wide); room banner message and station assignments (room-scoped). |
| /projector?room=… | Full-screen projection view (§10.5). Timer only, largest possible font, black background, inverse-color border, message display. No controls. |

MRU room ordering MUST be persisted in localStorage under key tca-timer.recentRooms as a JSON array of room IDs, max length 10, last-visited first.

## **10.3 Mobile-first responsive design**

**This is non-negotiable: judges work the contest floor with phones. The SPA MUST be fully usable one-handed on a 360 px viewport.**

| Breakpoint | Layout |
| :---- | :---- |
| \< 768 px (phone) | Single column. Bottom tab bar (Timer/Help/Log/Settings), sticky to safe-area-inset-bottom. Hamburger header. |
| 768 – 1024 px (tablet) | Single column with persistent left sidebar. |
| ≥ 1024 px (desktop) | Two columns: sidebar \+ main content. |

**Help-queue mobile rules:**

* Each row MUST be at least 56 px tall.

* Acknowledge button MUST be full-width within the row on phone breakpoints.

* The entire row MUST be tappable to expand details (station info, last help-call from same contestant).

* On desktop, Acknowledge is a right-aligned button.

**Timer controls mobile rules:**

* −5 / −1 / \+1 / \+5 buttons render as a 2×2 grid of pill buttons on phones.

* Start / Pause / Stop is a full-width primary button below the grid on phones.

* Free-form duration entry is hidden behind a disclosure ("Advanced").

**PWA \+ connectivity:**

* App MUST be installable to home screen (manifest with display=standalone).

* Service worker MUST cache the app shell.

* On foreground (visibility change to visible), the WebSocket MUST be eagerly reopened if disconnected; the most recent STATE and HELP\_QUEUE MUST be re-fetched.

* Push notifications MUST NOT be implemented. SMS and email cover this need without per-device permission requests.

**Lighthouse mobile thresholds (release gates):**

* Performance ≥ 90\.

* Accessibility \= 100\.

* Best Practices ≥ 95\.

## **10.4 UX behaviors**

* **Timer Set:** no confirmation modal. Pick duration, press Start, it's live. Provide a 30-second "undo" affordance after a fresh set.

* **Timer adjust:** −5 / −1 / \+1 / \+5 minute pills are the primary controls. Free-form input is in the Advanced disclosure.

* **Connected-client count** ("23 contestant overlays connected") MUST be visible on the Timer screen at all times. Source: server emits this in every STATE broadcast as a connectedContestants field appended to the schema for SPA consumption only.

* **Help acknowledge:** one tap, no confirmation. Recoverable from audit log if mistaken.

* **Room switcher:** clicking the room name in the header opens a popover with the judge's accessible rooms; selecting one navigates to that room with state reset.

## **10.5 Projection mode**

The SPA MUST provide a full-screen projection view at /projector?room=… designed to be displayed on a dedicated monitor or projector visible to the entire contest room. This page runs in a standard web browser (not the desktop app). It is **read-only** — no controls, no navigation, no interactive elements.

**Visual spec:**

* **Background:** pure black (\#000000) filling the entire viewport.

* **Timer digits:** centered both horizontally and vertically. Font size MUST be computed dynamically using vw units to fill as much of the viewport width as possible while maintaining aspect ratio. Target: digits fill \~85% of viewport width. Use the same monospace font as the desktop overlay (JetBrains Mono or system monospace fallback).

* **Color states:** identical to the desktop overlay (§9.2): green \>5 min, amber 1–5 min, red \<1 min with 1 Hz pulse, gray for idle, white for paused).

* **Contrast border on digits:** identical rule to §9.2 — the time text MUST have a stroke/outline in the inverse color. On a black background this is strictly necessary for green-on-black and amber-on-black readability from the back of a room.

* **Message banner:** if STATE.message is non-empty, render it below the timer in white text at \~5% viewport height font size. If the message is empty, show nothing — do not reserve vertical space for it.

* **Idle state:** show "--:--" centered, gray, with no message.

* **Paused state:** show time digits in white with a "PAUSED" pill beneath, same vertical center.

* **Connection status:** a small (16 px) indicator dot in the bottom-right corner: green \= connected, amber \= reconnecting, red \= disconnected. This is the only non-timer element.

* **Cursor auto-hide:** after 3 seconds of no mouse movement, hide the cursor (cursor: none). Restore on movement.

* **No browser chrome:** the page SHOULD suggest full-screen via the Fullscreen API on first click/tap, with a brief overlay instruction ("Click anywhere to enter full screen"). Once in fullscreen, the instruction disappears and does not return unless the user exits fullscreen.

**Technical notes:**

* This page uses the same WebSocket connection, time-sync, and Zustand store as the rest of the SPA. It is a route, not a separate app.

* The page MUST NOT include the navigation bar, bottom tabs, or any SPA chrome. The React component tree for this route is a flat render of the timer state.

* Authentication: still requires a valid CF Access JWT (same origin). A judge navigates to /projector?room=… from the main SPA or via a bookmarked URL on the dedicated projection machine.

* The CountdownWithBorder component (shared with the desktop overlay's rendering logic for consistency) is the authoritative renderer for the timer digits \+ border. Both the projector and the desktop overlay SHOULD use the same visual logic.

# **11\. Backend service**

## **11.1 Stack & hosting**

* **Runtime:** Node.js 22.x.

* **HTTP framework:** Fastify 4.x.

* **WebSocket:** the ws library (NOT Socket.IO).

* **Database driver:** the official pg driver with pg-pool.

* **Migrations:** node-pg-migrate.

* **JWT:** the jose library for Cloudflare Access JWT verification with JWKS caching.

* **Hashing:** the bcrypt library (cost factor 12\) for room token hashes.

* **SMS:** the twilio Node package, lazy-loaded only when TWILIO\_ACCOUNT\_SID is set.

* **Email:** the @aws-sdk/client-sesv2 package (AWS SDK v3), lazy-loaded only when SES\_FROM\_ADDRESS is set.

* **SNS signature validation:** the sns-validator library for SES bounce/complaint webhooks.

* **Logging:** Fastify's built-in pino logger; INFO in production, DEBUG in dev.

**Hosting:** Railway, two services in one project:

* Node service (this codebase). Builds via Nixpacks. Health check on GET /healthz.

* Managed Postgres 15+. DATABASE\_URL injected automatically.

Public hostname is fronted by a Cloudflare Tunnel pointed at the Railway-assigned domain. Railway's domain MUST NOT be exposed directly.

**Required environment variables:**

| Variable | Purpose | Required? |
| :---- | :---- | :---- |
| DATABASE\_URL | Postgres connection string | Yes (Railway-injected) |
| PORT | Listen port | Yes (Railway-injected) |
| CF\_ACCESS\_AUD | Expected aud claim on judge JWTs | Yes |
| CF\_ACCESS\_ISSUER | Expected iss claim on judge JWTs | Yes |
| CF\_ACCESS\_JWKS\_URL | JWKS endpoint URL | Yes |
| PUBLIC\_ORIGIN | Public URL of the SPA, used in email body links | Yes |
| TWILIO\_ACCOUNT\_SID | Twilio account SID | If SMS enabled |
| TWILIO\_AUTH\_TOKEN | Twilio auth token | If SMS enabled |
| TWILIO\_FROM\_NUMBER | E.164 sender number | If SMS enabled |
| AWS\_ACCESS\_KEY\_ID | AWS credentials for SES | If email enabled |
| AWS\_SECRET\_ACCESS\_KEY | AWS credentials for SES | If email enabled |
| AWS\_REGION | SES region (e.g., us-east-1) | If email enabled |
| SES\_FROM\_ADDRESS | Verified SES sender | If email enabled |
| SES\_CONFIGURATION\_SET | SES config set name | If email enabled |
| SES\_SNS\_TOPIC\_ARN | SNS topic for bounce/complaint | If email enabled |

## **11.2 HTTP & WebSocket endpoints**

| Method \+ path | Auth | Purpose |
| :---- | :---- | :---- |
| GET  /healthz | none | Returns 200 with DB connectivity status. |
| POST /api/judge/ticket | CF Access JWT | Mints a 30-second WebSocket ticket. |
| GET  /api/judge/rooms | CF Access JWT | Lists rooms accessible to caller (per groups claim). |
| GET  /api/judge/log?room=…\&since=…\&limit=… | CF Access JWT (room-gated) | Audit log, JSON. |
| GET  /api/judge/log.csv?room=…\&since=… | CF Access JWT (room-gated) | Audit log, CSV. |
| GET  /api/judge/prefs | CF Access JWT | Returns caller's preferences row. |
| PUT  /api/judge/prefs | CF Access JWT | Upserts caller's preferences. Triggers verification flow on phone/email change. |
| POST /api/judge/prefs/verify-phone | CF Access JWT | Body: { code }. Activates SMS. |
| POST /api/judge/prefs/verify-email | CF Access JWT | Body: { code }. Activates email. |
| POST /api/admin/rooms | CF Access JWT (judges-admin) | Creates a room. Returns the room token once. |
| POST /api/admin/rooms/:id/rotate-token | CF Access JWT (judges-admin) | Rotates a room's token. Returns new token once. |
| POST /api/webhooks/twilio | Twilio HMAC signature | Inbound SMS status (STOP, delivery). |
| POST /api/webhooks/ses | SNS signature | SES bounce/complaint events. |
| WSS  /judge?room=…\&ticket=… | WS ticket | Judge WebSocket. See §5. |
| WSS  /contestant?room=…\&id=…\&token=… | Room token | Contestant WebSocket. See §5. |

## **11.3 Postgres schema**

Authoritative DDL. Implementer MUST place this in server/src/db/schema.sql and split into migrations as desired.

| \-- Rooms registry. The token is never stored in plaintext. CREATE TABLE rooms (   id            TEXT PRIMARY KEY                 CHECK (id \~ '^\[a-z0-9\]\[a-z0-9-\]{1,62}$'),   display\_label TEXT NOT NULL,   token\_hash    TEXT NOT NULL,                  \-- bcrypt hash, cost 12   created\_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   archived\_at   TIMESTAMPTZ );   \-- Station assignments: maps contestant IDs to physical station numbers per room. CREATE TABLE station\_assignments (   room            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,   contestant\_id   TEXT NOT NULL                   CHECK (contestant\_id \~ '^\[a-z0-9.\_-\]{1,32}$'),   station\_number  INT NOT NULL,   PRIMARY KEY (room, contestant\_id) ); CREATE INDEX station\_assignments\_room ON station\_assignments(room);   \-- Current timer state, one row per room. Used to recover after restart. CREATE TABLE timer\_state (   room              TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,   version           BIGINT NOT NULL,   status            TEXT NOT NULL CHECK (status IN ('idle','running','paused')),   ends\_at\_server\_ms BIGINT,                     \-- non-null iff running   remaining\_ms      BIGINT,                     \-- non-null iff paused   message           TEXT NOT NULL DEFAULT '',   set\_by\_sub        TEXT NOT NULL,              \-- judge JWT sub   set\_by\_email      TEXT NOT NULL,              \-- snapshot at write time   set\_at\_server\_ms  BIGINT NOT NULL );   \-- Per-judge notification preferences. Keyed on JWT sub, NEVER on email. CREATE TABLE judge\_prefs (   sub                       TEXT PRIMARY KEY,   last\_seen\_email           TEXT NOT NULL,   \-- SMS   phone\_e164                TEXT,   phone\_status              TEXT NOT NULL DEFAULT 'none'                             CHECK (phone\_status IN ('none','pending','verified','opted\_out')),   pending\_phone\_code\_hash   TEXT,   pending\_phone\_expires\_at  TIMESTAMPTZ,   \-- Email   email\_address             TEXT,   email\_status              TEXT NOT NULL DEFAULT 'none'                             CHECK (email\_status IN ('none','pending','verified','opted\_out')),   pending\_email\_code\_hash   TEXT,   pending\_email\_expires\_at  TIMESTAMPTZ,   \-- Common   enabled\_rooms             TEXT\[\] NOT NULL DEFAULT '{}',   quiet\_hours\_start         TIME,   quiet\_hours\_end           TIME,   quiet\_hours\_weekdays      SMALLINT NOT NULL DEFAULT 0                             CHECK (quiet\_hours\_weekdays BETWEEN 0 AND 127),   timezone                  TEXT NOT NULL DEFAULT 'UTC',   updated\_at                TIMESTAMPTZ NOT NULL DEFAULT now() );   \-- Append-only audit log. Retained 90 days then auto-pruned. CREATE TABLE audit\_log (   id            BIGSERIAL PRIMARY KEY,   room          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,   at\_server\_ms  BIGINT NOT NULL,   actor\_sub     TEXT NOT NULL,           \-- 'system' for non-user events   actor\_email   TEXT,                    \-- snapshot for human readability   event\_type    TEXT NOT NULL,           \-- see §11.4   payload       JSONB NOT NULL DEFAULT '{}' );   CREATE INDEX audit\_log\_room\_at ON audit\_log(room, at\_server\_ms DESC); CREATE INDEX audit\_log\_at      ON audit\_log(at\_server\_ms DESC); |
| :---- |

## **11.4 Audit log event types**

| event\_type | Emitted when | payload fields |
| :---- | :---- | :---- |
| ROOM\_CREATED | POST /api/admin/rooms | { display\_label } |
| ROOM\_TOKEN\_ROTATED | POST /api/admin/rooms/:id/rotate-token | {} |
| TIMER\_SET | judge sends TIMER\_SET | { durationMs, message } |
| TIMER\_PAUSE | judge sends TIMER\_PAUSE | { remainingMs } |
| TIMER\_RESUME | judge sends TIMER\_RESUME | { endsAtServerMs } |
| TIMER\_ADJUST | judge sends TIMER\_ADJUST | { deltaMs, newEndsAtServerMs?, newRemainingMs? } |
| TIMER\_RESET | judge sends TIMER\_RESET | {} |
| HELP\_REQUEST | contestant adds to queue | {} |
| HELP\_CANCEL | contestant cancels own request | {} |
| HELP\_ACK | judge acknowledges | { contestantId, waitMs } |
| NOTIFY\_DROPPED | 5-second worker finds queue empty | { contestantId, judgesPrepared } |
| SMS\_SENT | Twilio accepted message | { judgeSub, twilioSid } |
| SMS\_FAILED | Twilio rejected after retry | { judgeSub, errorCode } |
| EMAIL\_SENT | SES accepted message | { judgeSub, sesMessageId } |
| EMAIL\_FAILED | SES rejected after retry | { judgeSub, errorCode } |
| EMAIL\_OPTED\_OUT | SES bounce/complaint webhook | { judgeSub, kind: 'bounce' | 'complaint' } |
| SMS\_OPTED\_OUT | Twilio STOP webhook | { judgeSub } |
| RATE\_LIMIT\_CLOSE | connection closed for abuse | { frameType, count } |

**Retention:** a daily job MUST delete rows from audit\_log where at\_server\_ms \< (now \- 90 days).

## **11.5 In-memory state model**

**Server holds a** Map\<roomId, RoomState\>:

| interface RoomState {   timer:        TimerState;   helpQueue:    HelpQueue;   contestants:  Set\<WebSocket\>;     // /contestant connections in this room   judges:       Set\<WebSocket\>;     // /judge connections in this room   notifyJobs:   Map\<contestantId, NodeJS.Timeout\>;  // pending 5-second SMS/email jobs   judgeAckedAt: Map\<judgeSub, number\>;              // for 30-second debounce } |
| :---- |

**Mutation discipline:** for every state change, the server MUST in this order:

1. Update in-memory state.

2. Begin async write to Postgres (UPSERT timer\_state or queue/log inserts).

3. Broadcast the resulting STATE/HELP\_QUEUE frame to all connected clients in the room. Broadcast MUST NOT await the DB write.

4. If the DB write fails, append to an in-process ring buffer (max 1000 entries) for retry; surface a yellow status pill in the SPA via a connectedContestants sibling field dbDegraded.

## **11.6 Server clock**

* The server MUST use Date.now() (system clock) as its source of authoritative time.

* Railway hosts are NTP-synced by the platform.

* The server SHOULD periodically sample its drift against an HTTP Date header from https://time.cloudflare.com (every 5 minutes). Drift \> 200 ms appends a warning to the audit log under event\_type='SYSTEM\_CLOCK\_WARN'.

# **12\. Failure modes & required behaviors**

| Failure | Detection | Required behavior |
| :---- | :---- | :---- |
| Contestant network drop | WebSocket close on client | Dim overlay opacity to 0.7; continue counting from last endpoint; reconnect with backoff (§9.7). |
| Server restart | All clients see WS close | Server reloads each room's TimerState from Postgres on startup; broadcasts STATE on first reconnect from each client. |
| Postgres temporarily unreachable | Write returns error | In-memory state authoritative; broadcast continues; failed writes go to ring buffer; SPA shows yellow degraded pill. |
| Contestant clock drifts | Offset diverges from prior median | Sliding median (§6.3) absorbs it within one ping cycle (\~30 s). |
| CF Access token expires mid-session | Server rejects next ticket-mint | SPA shows banner; calls /api/judge/ticket again silently when foreground; on success, reconnects. |
| Two judges Acknowledge same entry | Server compares HELP\_QUEUE version | First wins; second is no-op; both UIs converge on next broadcast. |
| Contestant cancels before notify dispatch | 5-second worker re-checks queue | Notification dropped; audit-log row NOTIFY\_DROPPED. |
| Contestant ID fails regex | Server validates on upgrade | WS upgrade returns 400; overlay shows config error. |
| No room/token configured | All §9.4 sources empty | Overlay shows config error; tray tooltip lists tried sources; do NOT connect. |
| Wrong room token | bcrypt compare fails | WS upgrade returns 401; overlay shows auth error; reconnect throttled to 1/min. |
| Judge enters unauthorized room | groups claim missing | Ticket-mint or upgrade returns 403; SPA shows 'Not authorized'. |
| Twilio outage | SDK call fails twice | SMS\_FAILED logged; WebSocket alerting still works; SPA health pill yellow. |
| SES bounce | SNS webhook event | phone\_status → opted\_out; EMAIL\_OPTED\_OUT logged. |
| Misbehaving client | Per-conn counter exceeds threshold | Excess frames dropped; if abuse threshold hit, close with 1008 \+ RATE\_LIMIT\_CLOSE log. |
| Postgres clock disagrees with Node clock | (out of scope) | We trust Date.now() exclusively (§11.6); not relevant to correctness. |

# **13\. Test plan**

**Each item below MUST pass before release.**

## **13.1 Unit tests**

* Timer state machine: every transition in §6.5's table MUST have a unit test asserting the new status and field values.

* Offset computation: feed synthetic (t0, t1, t2, t3) tuples; assert the median-of-6 algorithm produces the documented active offset.

* Help-queue idempotency: two consecutive HELP\_REQUEST from the same contestant produce one entry.

* Quiet-hours evaluation: cover regular windows, overnight windows (end \< start), weekday bitmask, timezone application.

* Group → room access: every branch of judgeRoomAccess() in §8.1.

## **13.2 Integration tests**

* **Drift soak:** 3-hour timer with 50 simulated clients, 50–100 ms injected RTT, ±15 s clock skew every 5 min on each client. Every client display MUST stay within ±1 s of server-truth at every sample.

* **Reconnect:** drop+restore each client at 1 s, 30 s, 5 min intervals. Max display jump ≤ 2 s.

* **Reconnect storm:** 100 clients reconnect within 100 ms. Backoff jitter MUST spread their successful reconnects over ≥ 5 s.

* **Help-call ordering:** 20 simulated contestants press button within 200 ms. Server-receive order matches queue order matches audit-log order.

* **Help-cancel paths:** (a) self-cancel; (b) judge ack; (c) self-cancel exactly when judge clicks ack (race); (d) contestant disconnect without cancel (server heartbeat sweeps after 90 s).

* **Auth fuzzing:** expired JWT, foreign aud, no JWT, group mismatch, wrong room token, foreign room token, missing token. All MUST fail closed with documented status codes.

* **Rate-limit:** drive a connection at 100 PING/min and 30 HELP\_REQUEST/min. Documented thresholds MUST trigger.

* **Multi-room isolation:** two rooms concurrent. Timer/help/audit MUST NOT cross. Latency in room A unaffected by traffic in room B.

* **Postgres failover:** kill DB connection mid-contest. Broadcasts continue, ring buffer fills, flushes on recovery without log loss.

* **Notify dispatch:** (a) SMS+email path with verified judge; (b) cancel within 5 s suppresses; (c) outside quiet hours sends; (d) inside quiet hours suppresses; (e) opt-out via Twilio STOP suppresses; (f) opt-out via SES bounce suppresses.

## **13.3 Mobile tests**

* iPhone SE viewport (360 px): SPA fully usable one-handed. Acknowledge-help in ≤ 2 taps.

* iPad portrait: layout transitions correctly through tablet breakpoint.

* Android Chrome (latest): WS reconnects on foreground after screen-lock.

* Lighthouse mobile: Performance ≥ 90, Accessibility \= 100, Best Practices ≥ 95\.

## **13.4 Desktop tests**

* Preferences persist: toggle alarm and flash; restart app; values persist via preferences.json.

* Corrupted preferences: write malformed JSON; app falls back to defaults, surfaces tray warning, does NOT crash, does NOT overwrite the file.

* Alarm firing: timer reaches 00:00; alarm plays exactly once; second crossing within 30 s does NOT re-fire.

* Flash threshold: cross threshold; flashing starts; TIMER\_ADJUST adds time; flashing stops.

* Multi-monitor: change primary display while running; overlay repositions to configured corner on new primary.

* No room/token configured: configuration error displays; reconnect attempts NOT made.

* Non-interactive: verify the overlay window does not respond to any mouse event (click, right-click, hover, drag, scroll). Mouse events MUST pass through to the window underneath.

* Contrast border: overlay a timer with green, amber, and red digits over a white background, a black background, and a busy photo wallpaper. Timer digits MUST be legible in all cases.

* IPC shortcuts: click "Call Judge" desktop shortcut; verify toast appears and HELP\_REQUEST reaches the backend. Click "Cancel Help" shortcut; verify toast and HELP\_CANCEL. Click "Show Timer" / "Hide Timer" shortcuts; verify overlay toggles visibility.

* IPC while disconnected: click "Call Judge" shortcut while WebSocket is down; verify toast says "queued offline"; reconnect; verify HELP\_REQUEST is sent on reconnect.

* IPC app not running: click a shortcut when the main app process is not running; verify tca-timer-ctl.exe shows a toast: "TCA Timer is not running" and exits cleanly (no crash, no console flash).

* Position via tray: change position from each corner option (TL/TR/BL/BR) via the tray menu; verify the overlay repositions correctly with 24 px margin.

## **13.5 Projection mode tests**

* Navigate to /projector?room=…; verify timer renders centered, full-viewport, black background, correct color states.

* Set STATE.message to a non-empty string; verify it appears below the timer. Clear it; verify the space collapses.

* Contrast border on projector: green/amber/red digits on black background all have the documented inverse-color outline.

* Full-screen: click the viewport; browser enters Fullscreen API mode; instruction overlay disappears.

* Cursor auto-hide: leave mouse still for 3 seconds in fullscreen; cursor disappears; move mouse; cursor returns.

* Reconnect: kill the WebSocket while in projector view; connection-status dot turns red; reconnect; dot turns green; timer resumes without page reload.

* No SPA chrome: verify no navigation bar, tabs, or interactive elements are present on the projector route.

## **13.6 Acceptance**

**Dogfood test:** run a full mock contest with 3 judges and 30 contestants who have not seen the system before. Acceptance criterion: judges complete the contest without asking how to use the system. If they ask, the failing affordance is a release blocker.

# **14\. Migration & deployment**

## **14.1 Build phases**

1. **Backend skeleton:** Fastify server, Postgres connection, health check, CF JWT verification, ticket-mint endpoint. Verifiable via curl \+ a valid CF cookie.

2. **Time-sync harness:** PING/PONG implemented, offset computation in a CLI test client, drift soak passing.

3. **Timer \+ WebSocket:** full state machine, judge endpoint, broadcast logic. Validates against §13.1 and §13.2 timer tests.

4. **Contestant endpoint \+ room tokens:** contestant WebSocket, token verification, rate limits. Multi-room isolation test passes.

5. **Judge SPA — Timer screen:** desktop layout first; verify timer set/pause/resume/adjust round-trip works.

6. **Help-call:** contestant button \+ judge queue \+ bidirectional cancel. All §13.2 help-cancel tests pass.

7. **Mobile responsive pass:** phone/tablet breakpoints; PWA manifest \+ SW. Lighthouse passes.

8. **Projection mode:** the /projector route renders full-screen timer with correct colors, borders, and message display (§10.5).

9. **Notifications:** Twilio adapter, SES adapter, dispatcher with debounce \+ auto-cancel, verification flow, webhook handlers.

10. **Desktop overlay \+ IPC:** Tauri shell, non-interactive window, time-sync, contrast-border digits, preferences, alarm, flash. Local HTTP control API (§9.6) and tca-timer-ctl.exe companion.

11. **Audit log \+ CSV export:** Final piece before sanctioned use.

12. **CI pipelines:** GitHub Actions workflows for server (lint \+ test \+ deploy), SPA (build), and desktop (MSI artifact via tauri-apps/tauri-action, attached to GitHub Releases).

13. **Decommission legacy:** Archive both legacy repos with a README pointer. Tear down Firebase project after a 90-day quiet period.

## **14.2 Deployment runbook**

1. Provision Railway project; add Node service and Postgres plugin.

2. Set environment variables per §11.1.

3. Run npm run migrate against the Railway Postgres instance.

4. Configure Cloudflare Access application: protect the SPA origin and /api/judge/\*, /api/admin/\*; create groups judges-\<roomId\> and judges-admin.

5. Configure Cloudflare Tunnel pointing at the Railway-assigned domain.

6. (Optional) Provision Twilio account, set env vars.

7. (Optional) Provision AWS SES with a verified sender, configuration set, and SNS topic for bounces; set env vars; configure SNS to POST to /api/webhooks/ses.

8. Create initial rooms via POST /api/admin/rooms; capture each token. Upload station assignments if available.

9. Download the MSI from the latest GitHub Release. Bake into VM golden image alongside room IDs, tokens (§9.4), and desktop shortcuts (§9.6.3).

10. Distribute golden images to contest VMs.

# **15\. Glossary**

| Term | Definition |
| :---- | :---- |
| Active offset | The median of 6 (after dropping 2 worst by RTT) of the most recent 8 client–server time-sync samples. Used to translate server-clock endpoints into local-clock render targets. |
| Contestant | A student logged into a contest VM. Identified by OS username within a room. |
| Help queue | The ordered list of contestants in one room currently awaiting a judge. |
| Judge | A Cloudflare Access-authenticated user, identified by JWT sub. Has access to one or more rooms via group membership. |
| Room | Unit of state isolation. Each room has its own timer, help queue, audit log, and contestant token. |
| Room token | 256-bit secret shared by all contestant agents in one room, baked into the VM golden image. |
| Ticket | 30-second single-use credential minted from a CF Access JWT, used to authenticate a judge WebSocket upgrade. |
| TimerState | Server-authoritative state machine for one room's timer. See §6.5. |
| Warm-up burst | The 4 PINGs spaced 1 second apart that a client sends on connect to seed the offset window. |

