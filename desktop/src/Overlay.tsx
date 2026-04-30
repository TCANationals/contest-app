import { useEffect, useRef, useState } from 'react';

import { countdownStyle, formatCountdown } from '@tca-timer/shared';

import { layoutForCorner } from './layout';
import { computeRemainingMs, shouldFireAlarm, shouldFlash } from './timer';
import { buildContestantUrl } from './url';
import type {
  BootstrapPayload,
  PositionCorner,
  Preferences,
  TimerState,
} from './types';
import { WsClient } from './ws-client';

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

async function tauriInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  const w = window as unknown as TauriWindow & {
    __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<T> };
  };
  const internals = w.__TAURI_INTERNALS__;
  if (internals && typeof (internals as { invoke?: unknown }).invoke === 'function') {
    return (internals as { invoke: (c: string, a?: unknown) => Promise<T> }).invoke(
      cmd,
      args,
    );
  }
  throw new Error('Tauri invoke bridge unavailable');
}

type UnlistenFn = () => void;

async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  const mod = (await import('@tauri-apps/api/event').catch(() => null)) as
    | { listen: <P>(e: string, cb: (e: { payload: P }) => void) => Promise<UnlistenFn> }
    | null;
  if (!mod) return () => undefined;
  return mod.listen<T>(event, (e) => handler(e.payload));
}

async function tauriEmit(event: string, payload: unknown): Promise<void> {
  const mod = (await import('@tauri-apps/api/event').catch(() => null)) as
    | { emit: (e: string, p: unknown) => Promise<void> }
    | null;
  if (!mod) return;
  await mod.emit(event, payload);
}

const IDLE_TIMER: TimerState = {
  room: '',
  version: 0,
  status: 'idle',
  endsAtServerMs: null,
  remainingMs: null,
  message: '',
  setBySub: '',
  setByEmail: '',
  setAtServerMs: 0,
};

export function Overlay() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [timer, setTimer] = useState<TimerState>(IDLE_TIMER);
  const [offsetMs, setOffsetMs] = useState(0);
  const [connected, setConnected] = useState(false);
  const [visible, setVisible] = useState(true);
  // Mirrors the Tauri-side `current_corner`: which screen corner the
  // overlay window is anchored to. We hug that same corner with our
  // flex alignment so the digits sit right against the screen edge
  // (`EDGE_MARGIN` away in the host code) instead of floating in the
  // middle of the 380×96 window. Defaults to `bottomRight` to match
  // the default Preferences corner — the bootstrap payload below
  // overrides it as soon as it lands, and the
  // `overlay:set-corner` event tracks subsequent tray-driven moves.
  const [corner, setCorner] = useState<PositionCorner>('bottomRight');
  // `renderTick` exists purely to force a re-render every 250 ms so the
  // derived `displayMs` below re-evaluates against the wall clock. Its
  // value is ignored.
  const [, setRenderTick] = useState(0);
  // Shared 1 Hz on/off phase for both the sub-minute pulse (§9.2) and
  // the under-threshold flash (§9.5.2). When both apply simultaneously
  // the flash (0/1) dominates the pulse (0.55/1); see the opacity
  // calculation below.
  const [blinkPhase, setBlinkPhase] = useState(false);

  const clientRef = useRef<WsClient | null>(null);
  const prevRemRef = useRef<number>(Number.POSITIVE_INFINITY);
  const lastAlarmRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    tauriInvoke<BootstrapPayload>('get_bootstrap')
      .then((payload) => {
        if (!cancelled) {
          setBootstrap(payload);
          setVisible(!payload.preferences.hidden);
          setCorner(payload.preferences.position.corner);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setBootstrapError(
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    // Listeners are registered in parallel via Promise.all so a single
    // failure does not abort the rest. Each registration has its own
    // try/catch — mostly defensive: in dev we've seen the event-bridge
    // permission check reject one listener and the previous serial
    // setup would short-circuit there, leaving every later listener
    // unregistered. Now they're independent.
    const tryListen = async <T,>(event: string, handler: (p: T) => void) => {
      try {
        const u = await tauriListen<T>(event, handler);
        unlisteners.push(u);
      } catch {
        // ignore: the overlay must still render even if one event
        // type cannot be subscribed to (e.g. permissions misconfig).
      }
    };
    void Promise.all([
      tryListen<boolean>('overlay:set-visible', (v) => setVisible(v)),
      tryListen<void>('overlay:send-help-request', () => {
        const client = clientRef.current;
        if (client) client.sendHelpRequest();
      }),
      tryListen<void>('overlay:send-help-cancel', () => {
        const client = clientRef.current;
        if (client) client.sendHelpCancel();
      }),
      tryListen<PositionCorner>('overlay:set-corner', (c) => setCorner(c)),
    ]);
    return () => {
      for (const u of unlisteners) u();
    };
  }, []);

  useEffect(() => {
    if (!bootstrap || !bootstrap.config) return;
    const url = contestantUrlFromBootstrap(bootstrap);
    const client = new WsClient({
      url,
      onState: (s) => setTimer(s),
      onStatus: ({ connected: c }) => {
        setConnected(c);
        void tauriEmit('overlay:connection-changed', c);
      },
      onOffset: (o) => setOffsetMs(o),
      onHelpPendingChanged: (pending) => {
        void tauriEmit('overlay:help-pending-changed', pending);
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [bootstrap]);

  // 4 Hz ticker per §6.3. Forces a re-render every 250 ms so the
  // derived `displayMs` (computed below, synchronously from `timer` +
  // `offsetMs`) re-evaluates against the latest wall clock. The alarm
  // side-effect is checked at the same cadence.
  useEffect(() => {
    const id = setInterval(() => {
      setRenderTick((n) => (n + 1) | 0);
      const rem = computeRemainingMs(timer, offsetMs);
      const now = Date.now();
      if (
        bootstrap?.preferences?.alarm &&
        shouldFireAlarm({
          status: timer.status,
          remainingMs: rem,
          previousRemainingMs: prevRemRef.current,
          lastFiredAt: lastAlarmRef.current,
          now,
          enabled: bootstrap.preferences.alarm.enabled,
        })
      ) {
        lastAlarmRef.current = now;
        playAlarm(audioRef, bootstrap.preferences.alarm.volume);
      }
      prevRemRef.current = rem;
    }, 250);
    return () => clearInterval(id);
  }, [timer, offsetMs, bootstrap]);

  // Reset the alarm "previous remaining" tracker whenever the timer
  // state changes so that, e.g., a fresh TIMER_SET doesn't look like "we
  // just crossed zero" to `shouldFireAlarm` on the next tick.
  useEffect(() => {
    prevRemRef.current = computeRemainingMs(timer, offsetMs);
  }, [timer]);

  // 1 Hz on/off phase for flash + pulse (§9.2 / §9.5.2). Purely
  // cosmetic; does not affect timekeeping.
  useEffect(() => {
    const id = setInterval(() => {
      setBlinkPhase((x) => !x);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const prefs: Preferences | undefined = bootstrap?.preferences;
  // Derive `displayMs` synchronously from the current timer + offset so a
  // re-render triggered by a new STATE frame never displays the remaining
  // time from the previous timer (which would briefly flash "00:00" in
  // red when transitioning idle → running, etc.).
  const displayMs: number | null =
    timer.status === 'idle' ? null : computeRemainingMs(timer, offsetMs);
  const style = countdownStyle(timer.status, displayMs);
  const isRunning = timer.status === 'running';
  const rem = displayMs ?? 0;
  const flashing = shouldFlash(
    timer.status,
    rem,
    prefs?.flash.enabled ?? false,
    prefs?.flash.thresholdMinutes ?? 2,
  );

  const opacity = connected ? 1 : 0.7;
  // §9.5.2 flash (color ↔ transparent) dominates §9.2 pulse (1 ↔ 0.55)
  // when both apply in the final minute — otherwise multiplying them
  // collapses to the same binary on/off and the softer pulse is never
  // visible.
  const digitOpacity = flashing
    ? blinkPhase
      ? 0
      : 1
    : style.pulse && blinkPhase
      ? 0.55
      : 1;

  if (!visible) {
    return null;
  }

  if (bootstrapError) {
    return (
      <ConfigError message={`Bootstrap failed: ${bootstrapError}`} />
    );
  }

  if (bootstrap?.configError) {
    return (
      <ConfigError
        message={bootstrap.configError.message}
        report={bootstrap.report.sources
          .map(
            (s) =>
              `${s.source}: ${
                s.found.length ? `found ${s.found.join(', ')}` : 'missing'
              }${s.note ? ` (${s.note})` : ''}`,
          )
          .join('\n')}
      />
    );
  }

  // `formatCountdown` returns '--:--' for idle / null on its own, so
  // the explicit guard above is no longer necessary.
  const text = formatCountdown(timer.status, displayMs);

  // Flex alignment derived from the current screen corner. The Tauri
  // host pins the *window* `EDGE_MARGIN` away from the named screen
  // corner (e.g. bottom-left of the screen → bottom-left of the window
  // is 24px from the screen's bottom-left); we mirror that anchoring
  // *inside* the window so the visual content also hugs that edge.
  // Examples:
  //   topLeft     → contentleft, top      (digits in the window's top-left)
  //   topRight    → contentright, top     (digits in the window's top-right)
  //   bottomLeft  → contentleft, bottom
  //   bottomRight → contentright, bottom
  // Without this the 380×96 window centred its content, leaving the
  // digits floating ~80px+ inside whichever screen corner the window
  // was pinned to — which looks like a misaligned overlay.
  const cornerLayout = layoutForCorner(corner);

  return (
    <div
      data-testid="overlay"
      data-corner={corner}
      style={{
        opacity,
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: cornerLayout.alignItems,
        justifyContent: cornerLayout.justifyContent,
        textAlign: cornerLayout.textAlign,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <span
        data-testid="countdown"
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: '48px',
          fontWeight: 700,
          color: style.color,
          WebkitTextStroke: `2px ${style.outline}`,
          opacity: digitOpacity,
          transition: 'opacity 150ms linear',
          lineHeight: 1,
        }}
      >
        {text}
      </span>
      {timer.status === 'paused' && (
        <span
          data-testid="paused-pill"
          style={{
            marginTop: 4,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 1,
            color: '#fff',
            background: 'rgba(0,0,0,0.7)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          PAUSED
        </span>
      )}
      {isRunning && timer.message && (
        <span
          style={{
            marginTop: 4,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: 11,
            color: '#fff',
            WebkitTextStroke: '1px #000',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {timer.message}
        </span>
      )}
    </div>
  );
}

function ConfigError({
  message,
  report,
}: {
  message: string;
  report?: string;
}) {
  return (
    <div
      data-testid="config-error"
      style={{
        padding: '8px 12px',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: '#DC2626',
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1.2,
        textAlign: 'center',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <div>{message}</div>
      {report && (
        <pre
          style={{
            marginTop: 4,
            fontSize: 10,
            color: '#fff',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          {report}
        </pre>
      )}
    </div>
  );
}

function contestantUrlFromBootstrap(b: BootstrapPayload): string {
  const cfg = b.config!;
  return buildContestantUrl({
    room: cfg.room,
    contestantId: b.contestantId,
    roomToken: cfg.roomToken,
    serverHost: cfg.serverHost,
  });
}

function playAlarm(
  ref: React.MutableRefObject<HTMLAudioElement | null>,
  volume: number,
): void {
  try {
    if (!ref.current) {
      ref.current = new Audio();
    }
    const a = ref.current;
    a.volume = Math.max(0, Math.min(1, volume));
    a.src = '/alarm.wav';
    void a.play().catch(() => undefined);
    // §9.5.1: cap playback at 4 s.
    window.setTimeout(() => {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        // ignore
      }
    }, 4_000);
  } catch {
    // alarm failures must never crash the overlay
  }
}
