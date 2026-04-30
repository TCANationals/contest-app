import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { CountdownWithBorder } from '../components/CountdownWithBorder';
import { ConnectionPill } from '../components/ConnectionPill';
import { api } from '../api/client';
import { useJudgeSocket } from '../hooks/useWebSocket';
import { useRemainingMs } from '../hooks/useTimer';
import { useAppStore } from '../store';

/**
 * Full-screen projector view (§10.5). Intentionally bare:
 *   • Pure black background.
 *   • Timer centered, filling ~85% of viewport width.
 *   • Inverse-color outline on the digits (via CountdownWithBorder).
 *   • Optional message banner below.
 *   • Cursor auto-hide after 3 s stillness.
 *   • Request fullscreen on first click; instruction overlay disappears once entered.
 *   • A single 16 px connection dot in the bottom-right corner.
 */
export function ProjectorPage() {
  const [params] = useSearchParams();
  const room = params.get('room');
  const timer = useAppStore((s) => s.timer);
  const connection = useAppStore((s) => s.connection);
  const remainingMs = useRemainingMs();
  const [hideCursor, setHideCursor] = useState(false);
  const [inFullscreen, setInFullscreen] = useState(false);
  const [dismissedInstruction, setDismissedInstruction] = useState(false);
  const cursorTimer = useRef<number | null>(null);

  useJudgeSocket({
    room,
    mintTicket: async () => (await api.mintTicket()).ticket,
    disabled: !room,
  });

  useEffect(() => {
    const reset = () => {
      setHideCursor(false);
      if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
      cursorTimer.current = window.setTimeout(() => setHideCursor(true), 3000);
    };
    reset();
    window.addEventListener('mousemove', reset);
    window.addEventListener('touchstart', reset);
    return () => {
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('touchstart', reset);
      if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setInFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const onEnterFullscreen = () => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {
        setDismissedInstruction(true);
      });
    } else {
      setDismissedInstruction(true);
    }
  };

  const status = timer?.status ?? 'idle';
  const effectiveRemaining = status === 'paused' ? timer?.remainingMs ?? null : remainingMs;

  const dotColor = useMemo(() => {
    if (connection === 'connected') return '#16A34A';
    if (connection === 'reconnecting' || connection === 'connecting') return '#F59E0B';
    return '#DC2626';
  }, [connection]);

  const showInstruction = !inFullscreen && !dismissedInstruction;

  return (
    <div
      className={`fixed inset-0 bg-black text-white ${hideCursor ? 'no-cursor' : ''}`}
      onClick={showInstruction ? onEnterFullscreen : undefined}
      role="presentation"
    >
      <div className="h-full w-full flex flex-col items-center justify-center gap-6">
        <CountdownWithBorder
          status={status}
          remainingMs={effectiveRemaining}
          fontSize="min(28vw, 44vh)"
          strokeWidthPx={6}
        />
        {status === 'paused' && (
          <span className="text-white uppercase tracking-[0.3em] text-[3vh] bg-white/10 px-6 py-2 rounded-full">
            Paused
          </span>
        )}
        {timer?.message && (
          <div className="text-white text-[5vh] leading-none max-w-[90vw] text-center">
            {timer.message}
          </div>
        )}
      </div>

      {/* Connection dot (bottom-right). */}
      <div
        className="fixed bottom-4 right-4 flex items-center gap-2"
        aria-live="polite"
      >
        <span
          className="h-4 w-4 rounded-full"
          style={{ backgroundColor: dotColor }}
          aria-hidden="true"
        />
        <span className="sr-only">
          <ConnectionPill status={connection} />
        </span>
      </div>

      {showInstruction && (
        <div className="fixed inset-0 flex items-end justify-center pointer-events-none pb-16">
          <div className="bg-white/10 text-white rounded-full px-5 py-3 text-sm tracking-wide backdrop-blur-sm">
            Click anywhere to enter full screen
          </div>
        </div>
      )}
    </div>
  );
}
