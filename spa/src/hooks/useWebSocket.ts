import { useEffect, useRef } from 'react';

import { useAppStore } from '../store';
import type { JudgeOutboundFrame, ServerFrame } from '../store/types';
import { OffsetTracker } from './useTimer';

export interface UseJudgeSocketOptions {
  room: string | null;
  /** Called to obtain a fresh single-use ticket (§8.1). */
  mintTicket: () => Promise<string>;
  /** Optional override for the WS base URL. */
  wsBase?: string;
  /** Disable actual connection (tests or demo mode). */
  disabled?: boolean;
}

/**
 * Judge WebSocket connection with time-sync, reconnect, and store wiring.
 *
 * Spec refs:
 *  • §6.3  warm-up burst (4×1s), then 30s PINGs; sliding-median offset.
 *  • §6.4  reconnect backoff: base 1/2/4/8/16s with full jitter, cap 30s.
 *  • §10.3 re-open eagerly on tab foreground.
 */
export function useJudgeSocket(opts: UseJudgeSocketOptions): void {
  const { room, mintTicket, wsBase, disabled } = opts;
  const setConnection = useAppStore((s) => s.setConnection);
  const setTimer = useAppStore((s) => s.setTimer);
  const setHelpQueue = useAppStore((s) => s.setHelpQueue);
  const setOffset = useAppStore((s) => s.setOffset);
  const setError = useAppStore((s) => s.setError);
  const setSender = useAppStore((s) => s.setSender);
  const setRoom = useAppStore((s) => s.setRoom);

  const closedRef = useRef(false);
  const attemptRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const trackerRef = useRef<OffsetTracker>(new OffsetTracker());
  const timersRef = useRef<{ reconnect?: number; pingIv?: number; warm?: number[] }>({});
  // Keep the latest mintTicket callback in a ref so a new inline arrow from
  // the caller does not reconnect the socket on every render.
  const mintTicketRef = useRef(mintTicket);
  useEffect(() => {
    mintTicketRef.current = mintTicket;
  }, [mintTicket]);

  useEffect(() => {
    setRoom(room);
  }, [room, setRoom]);

  useEffect(() => {
    if (disabled || !room) {
      return;
    }

    closedRef.current = false;

    const send = (frame: JudgeOutboundFrame): boolean => {
      const s = socketRef.current;
      if (!s || s.readyState !== WebSocket.OPEN) return false;
      s.send(JSON.stringify(frame));
      return true;
    };
    setSender(send);

    const cleanupTimers = () => {
      if (timersRef.current.reconnect) {
        window.clearTimeout(timersRef.current.reconnect);
        timersRef.current.reconnect = undefined;
      }
      if (timersRef.current.pingIv) {
        window.clearInterval(timersRef.current.pingIv);
        timersRef.current.pingIv = undefined;
      }
      if (timersRef.current.warm) {
        timersRef.current.warm.forEach((id) => window.clearTimeout(id));
        timersRef.current.warm = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (closedRef.current) return;
      const attempt = attemptRef.current++;
      const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 4));
      const delay = Math.floor(Math.random() * base);
      setConnection(attempt === 0 ? 'connecting' : 'reconnecting');
      timersRef.current.reconnect = window.setTimeout(() => {
        void connect();
      }, delay);
    };

    const sendPing = () => {
      send({ type: 'PING', t0: Date.now() });
    };

    const connect = async () => {
      if (closedRef.current) return;
      setConnection(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      let ticket: string;
      try {
        ticket = await mintTicketRef.current();
      } catch (err) {
        if (closedRef.current) return;
        setError({ code: 'TICKET_FAILED', message: (err as Error).message });
        scheduleReconnect();
        return;
      }
      // A React StrictMode cleanup/re-mount may have flipped closedRef while
      // we were awaiting the ticket. If so, do not create a stray socket.
      if (closedRef.current) return;

      const base = wsBase ?? defaultWsBase();
      const url = `${base}/judge?room=${encodeURIComponent(room)}&ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;

      // Every event handler short-circuits when this socket is no longer the
      // tracked one. A foreground-reopen (or any other path that creates a
      // replacement) leaves the old in-flight socket with a still-pending
      // open/message/close event queue; without these guards, an orphan
      // socket's `open` handler would overwrite the *new* connection's warm/
      // ping timer refs and `message` would push duplicate STATE/HELP_QUEUE
      // updates from two live sockets at once.
      const isCurrent = () => socketRef.current === ws;

      ws.addEventListener('open', () => {
        if (closedRef.current || !isCurrent()) return;
        attemptRef.current = 0;
        trackerRef.current.reset();
        setConnection('connected');
        setError(null);
        // Warm-up burst: 4 PINGs spaced 1 s apart (§6.3).
        const warm: number[] = [];
        for (let i = 0; i < 4; i++) {
          warm.push(window.setTimeout(sendPing, i * 1000));
        }
        timersRef.current.warm = warm;
        // Steady-state: 1 PING per 30 s (§6.3).
        timersRef.current.pingIv = window.setInterval(sendPing, 30_000);
      });

      ws.addEventListener('message', (ev) => {
        if (!isCurrent()) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(ev.data as string) as ServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case 'PONG': {
            const t3 = Date.now();
            trackerRef.current.addSample(frame.t0, frame.t1, frame.t2, t3);
            setOffset(trackerRef.current.getActiveOffset());
            break;
          }
          case 'STATE':
            setTimer(frame.state);
            break;
          case 'HELP_QUEUE':
            setHelpQueue(frame.queue);
            break;
          case 'ERROR':
            setError({ code: frame.code, message: frame.message });
            break;
        }
      });

      ws.addEventListener('close', () => {
        // Mirrors the isCurrent() guard above: a stale socket's late close
        // event MUST NOT clear the new active connection's timers or schedule
        // a spurious reconnect.
        if (!isCurrent()) return;
        socketRef.current = null;
        cleanupTimers();
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      });
    };

    // Kick things off.
    attemptRef.current = 0;
    void connect();

    // §10.3: eagerly reopen on visibilitychange.
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) &&
        !closedRef.current
      ) {
        attemptRef.current = 0;
        // Tear down any in-progress (CONNECTING) or otherwise-not-OPEN socket
        // first. Detach it from socketRef BEFORE close() so the orphan's
        // open/message/close handlers all short-circuit via the `isCurrent`
        // guard inside connect(); otherwise the orphan would later overwrite
        // the fresh connection's timers and double-deliver STATE frames.
        const stale = socketRef.current;
        if (stale) {
          socketRef.current = null;
          try {
            stale.close(1000, 'foreground-reopen');
          } catch {
            /* noop */
          }
        }
        // Clear ALL existing timers (reconnect, pingIv, warm). Without this
        // the previous socket's 30s ping interval and warm-up timeouts keep
        // firing — and the new socket's `open` handler would silently
        // overwrite the timer refs, leaking the prior intervals forever.
        cleanupTimers();
        void connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      closedRef.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      cleanupTimers();
      const s = socketRef.current;
      if (s) {
        try {
          s.close(1000, 'unmount');
        } catch {
          /* noop */
        }
      }
      socketRef.current = null;
      setSender(() => false);
      setConnection('idle');
    };
    // Intentionally narrow deps: mintTicket is accessed via ref so callers
    // can pass an inline arrow without tearing the socket down each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, disabled, wsBase]);
}

function defaultWsBase(): string {
  if (typeof window === 'undefined') return '';
  const { protocol, host } = window.location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}`;
}
