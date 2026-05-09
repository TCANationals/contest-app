import { useEffect, useRef, useState } from 'react';

import {
  alarmBaselineKey,
  computeRemainingMs,
  countdownStyle,
  END_TIMER_ALARM_ASSET_PATH,
  formatCountdown,
  NEUTRAL_COUNTDOWN_STYLE,
  shouldFireAlarm,
} from '@tca-timer/shared';

import { layoutForCorner } from './layout';
import { overlayPaddingPx } from './overlayScreenInset';
import { shouldFlash } from './timer';
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
  // (`overlay_screen_inset` in `main.rs`) instead of floating in the
  // middle of the 380×96 window. Defaults to `bottomRight` to match
  // the default Preferences corner — the bootstrap payload below
  // overrides it as soon as it lands, and the
  // `overlay:set-corner` event tracks subsequent tray-driven moves.
  const [corner, setCorner] = useState<PositionCorner>('bottomRight');
  // `renderTick` exists purely to force a re-render every 250 ms so the
  // derived `displayMs` below re-evaluates against the wall clock. Its
  // value is ignored.
  const [, setRenderTick] = useState(0);
  // Shared 1 Hz phase for the sub-minute pulse (§9.2) and the
  // under-threshold flash (§9.5.2). Flash modulates outline stroke color
  // (black ↔ white); pulse still uses digit opacity when flash is on but
  // not yet in the flash window.
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
      tryListen<Preferences>('overlay:preferences-changed', (next) => {
        setBootstrap((prev) =>
          prev ? { ...prev, preferences: next } : prev,
        );
      }),
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

  // Reset the alarm "previous remaining" tracker only when the server
  // timer session changes (set / pause / idle / new endsAt). Resetting
  // on every STATE object reference would wipe the pre-zero sample when a
  // broadcast arrives already at 00:00, and `shouldFireAlarm` would never
  // see a positive → 0 crossing.
  const alarmBaseline = alarmBaselineKey(timer);
  useEffect(() => {
    prevRemRef.current = computeRemainingMs(timer, offsetMs);
    // `timer` omitted on purpose: baseline tracks server intent; a fresh
    // STATE JSON object each ping must not re-sync prevRem.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps = baseline + offset only
  }, [alarmBaseline, offsetMs]);

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
  const rawCountdownStyle = countdownStyle(timer.status, displayMs);
  const statusColorEnabled = prefs?.display.statusColor ?? true;
  const style = statusColorEnabled
    ? rawCountdownStyle
    : NEUTRAL_COUNTDOWN_STYLE;
  const isRunning = timer.status === 'running';
  const rem = displayMs ?? 0;
  const flashEnabled = prefs?.flash.enabled ?? false;
  const flashing = shouldFlash(
    timer.status,
    rem,
    flashEnabled,
    prefs?.flash.thresholdSeconds ?? 60,
  );

  const opacity = connected ? 1 : 0.7;
  // §9.2 gives `style.pulse` in the final minute (red digits). That pulse
  // must not run when flash is disabled. When flash is off, digits stay
  // steady even under one minute.
  // §9.5.2 under-threshold flash keeps digits fully opaque and animates
  // outline stroke black ↔ white (smooth via CSS transition). When flash
  // is on but remaining time is still above the threshold, §9.2 pulse
  // (opacity 1 ↔ 0.55) still applies in the final minute.
  const digitOpacity = flashing
    ? 1
    : flashEnabled && style.pulse && blinkPhase
      ? 0.55
      : 1;
  const flashOutlineColor = blinkPhase ? '#FFFFFF' : '#000000';
  const outlineStrokeColor = flashing ? flashOutlineColor : style.outline;
  const countdownTransition = flashing
    ? 'opacity 150ms linear, -webkit-text-stroke-color 450ms ease-in-out'
    : 'opacity 150ms linear';

  if (!visible) {
    return null;
  }

  if (bootstrapError) {
    return (
      <ConfigError corner={corner} message={`Bootstrap failed: ${bootstrapError}`} />
    );
  }

  if (bootstrap?.configError) {
    return (
      <ConfigError
        corner={corner}
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
  // host pins the *window* with `overlay_screen_inset`; `overlayPaddingPx`
  // applies matching in-window padding so content hugs the same corner.
  // Examples:
  //   topLeft     → contentleft, top      (digits in the window's top-left)
  //   topRight    → contentright, top     (digits in the window's top-right)
  //   bottomLeft  → contentleft, bottom
  //   bottomRight → contentright, bottom
  // Without this the 380×96 window centred its content, leaving the
  // digits floating ~80px+ inside whichever screen corner the window
  // was pinned to — which looks like a misaligned overlay.
  const cornerLayout = layoutForCorner(corner);
  const overlayPadding = overlayPaddingPx(corner);
  // Bottom corners use flex-end so the last DOM child hugs the screen
  // edge — ancillary lines must appear *before* the countdown so they sit
  // above the digits. Top corners use flex-start; canonical order keeps
  // ancillary below the countdown.
  const ancillaryAboveDigits =
    corner === 'bottomLeft' || corner === 'bottomRight';
  const ancillaryGap = ancillaryAboveDigits
    ? { marginBottom: 4 }
    : { marginTop: 4 };
  const showPaused = timer.status === 'paused';
  const showBanner = isRunning && Boolean(timer.message);
  // Single band for paused label + judge message (same chrome); reserve
  // height even when empty so the countdown does not shift.
  const ANCILLARY_SLOT_MIN_PX = 20;
  const ancillaryRowJustify: 'flex-start' | 'flex-end' =
    corner === 'topLeft' || corner === 'bottomLeft'
      ? 'flex-start'
      : 'flex-end';
  const ancillarySlotStyle = {
    ...ancillaryGap,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: ancillaryRowJustify,
    flexShrink: 0,
    width: '100%' as const,
    maxWidth: '100%' as const,
    boxSizing: 'border-box' as const,
  };

  const countdownEl = (
    <span
      data-testid="countdown"
      style={{
        fontFamily: 'Roboto Mono, ui-monospace, monospace',
        fontSize: '48px',
        fontWeight: 700,
        color: style.color,
        WebkitTextStrokeWidth: 2,
        WebkitTextStrokeColor: outlineStrokeColor,
        opacity: digitOpacity,
        transition: countdownTransition,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {text}
    </span>
  );

  const pausedSlotEl = (
    <div
      data-testid="paused-slot"
      style={{
        ...ancillarySlotStyle,
        minHeight: ANCILLARY_SLOT_MIN_PX,
      }}
    >
      {showPaused || showBanner ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            maxWidth: '100%',
            boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.7)',
            padding: '4px 8px',
            borderRadius: 4,
          }}
        >
          {showPaused ? (
            <span
              data-testid="paused-pill"
              style={{
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 1,
                color: '#fff',
                lineHeight: 1.2,
              }}
            >
              PAUSED
            </span>
          ) : null}
          {showBanner ? (
            <span
              data-testid="banner-message"
              style={{
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                fontSize: 11,
                fontWeight: 600,
                color: '#fff',
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {timer.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      data-testid="overlay"
      data-corner={corner}
      style={{
        opacity,
        ...overlayPadding,
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
      {ancillaryAboveDigits ? (
        <>
          {pausedSlotEl}
          {countdownEl}
        </>
      ) : (
        <>
          {countdownEl}
          {pausedSlotEl}
        </>
      )}
    </div>
  );
}

function ConfigError({
  corner,
  message,
  report,
}: {
  corner: PositionCorner;
  message: string;
  report?: string;
}) {
  return (
    <div
      data-testid="config-error"
      style={{
        ...overlayPaddingPx(corner),
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
    roomKey: cfg.roomKey,
    contestantId: b.contestantId,
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
    a.src = END_TIMER_ALARM_ASSET_PATH;
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
