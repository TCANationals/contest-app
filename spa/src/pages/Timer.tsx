import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { CountdownWithBorder } from '../components/CountdownWithBorder';
import { useRemainingMs } from '../hooks/useTimer';
import { sendFrame, useAppStore } from '../store';

const ADJUST_STEPS_MIN = [-5, -1, 1, 5];

export function TimerPage() {
  const [params] = useSearchParams();
  const room = params.get('room');
  const timer = useAppStore((s) => s.timer);
  const remainingMs = useRemainingMs();
  const [duration, setDuration] = useState({ mm: '30', ss: '00' });
  const [message, setMessage] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [undoPayload, setUndoPayload] = useState<{
    prevStatus: 'idle' | 'running' | 'paused';
    prevEndsAtServerMs: number | null;
    prevRemainingMs: number | null;
    expires: number;
  } | null>(null);
  const undoTimer = useRef<number | null>(null);

  useEffect(() => {
    // Clear stale undo banners when room changes.
    setUndoPayload(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }, [room]);

  const status = timer?.status ?? 'idle';

  const onStart = () => {
    const mm = Math.max(0, Math.floor(Number(duration.mm) || 0));
    const ss = Math.max(0, Math.min(59, Math.floor(Number(duration.ss) || 0)));
    const durationMs = (mm * 60 + ss) * 1000;
    if (durationMs <= 0) return;

    const prev = timer;
    const payload: { type: 'TIMER_SET'; durationMs: number; message?: string } = {
      type: 'TIMER_SET',
      durationMs,
    };
    if (message) payload.message = message;
    if (!sendFrame(payload)) return;

    setUndoPayload({
      prevStatus: prev?.status ?? 'idle',
      prevEndsAtServerMs: prev?.endsAtServerMs ?? null,
      prevRemainingMs: prev?.remainingMs ?? null,
      expires: Date.now() + 30_000,
    });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoPayload(null), 30_000);
  };

  const onPause = () => sendFrame({ type: 'TIMER_PAUSE' });
  const onResume = () => sendFrame({ type: 'TIMER_RESUME' });
  const onReset = () => sendFrame({ type: 'TIMER_RESET' });
  const onAdjust = (minutes: number) =>
    sendFrame({ type: 'TIMER_ADJUST', deltaMs: minutes * 60_000 });

  const onUndo = () => {
    sendFrame({ type: 'TIMER_RESET' });
    setUndoPayload(null);
  };

  const connectedCount = timer?.connectedContestants ?? null;

  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Timer</h1>
          {room && <p className="text-sm text-slate-500">Room <span className="font-mono">{room}</span></p>}
        </div>
        {connectedCount != null && (
          <span className="text-sm text-slate-600">
            <strong className="tabular-nums text-slate-900">{connectedCount}</strong> contestant
            {connectedCount === 1 ? '' : 's'} connected
          </span>
        )}
      </div>

      <div
        className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col items-center gap-3"
      >
        <div className="relative flex items-baseline justify-center">
          <CountdownWithBorder
            status={status}
            remainingMs={status === 'paused' ? timer?.remainingMs ?? null : remainingMs}
            fontSize="clamp(3.5rem, 18vw, 9rem)"
          />
        </div>
        {status === 'paused' && (
          <span className="uppercase text-xs tracking-[0.25em] bg-slate-100 text-slate-700 rounded-full px-3 py-1">
            Paused
          </span>
        )}
        {timer?.message && (
          <p className="text-slate-600 text-sm italic max-w-sm text-center">
            {timer.message}
          </p>
        )}
      </div>

      {/* Adjust grid: 2×2 on mobile, inline row on desktop. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {ADJUST_STEPS_MIN.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onAdjust(m)}
            disabled={status === 'idle'}
            className="py-3 rounded-xl font-semibold border border-slate-300 bg-white shadow-sm hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m > 0 ? `+${m}` : m} min
          </button>
        ))}
      </div>

      {/* Primary action row. */}
      <div className="grid gap-2 sm:grid-cols-2">
        {status !== 'running' ? (
          <button
            type="button"
            onClick={status === 'paused' ? onResume : onStart}
            className="bg-emerald-600 hover:bg-emerald-700 text-white py-4 rounded-xl font-bold text-lg shadow-sm"
          >
            {status === 'paused' ? 'Resume' : 'Start'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onPause}
            className="bg-amber-500 hover:bg-amber-600 text-white py-4 rounded-xl font-bold text-lg shadow-sm"
          >
            Pause
          </button>
        )}
        <button
          type="button"
          onClick={onReset}
          className="bg-white border border-slate-300 py-4 rounded-xl font-semibold text-slate-800 hover:bg-slate-100"
        >
          Reset
        </button>
      </div>

      {undoPayload && <UndoBanner onUndo={onUndo} expires={undoPayload.expires} />}

      <details
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
        className="bg-white rounded-xl border border-slate-200 p-4"
      >
        <summary className="cursor-pointer font-medium">Advanced</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-[auto_auto_1fr_auto]">
          <label className="flex flex-col text-sm">
            <span className="text-slate-500">Minutes</span>
            <input
              type="number"
              value={duration.mm}
              onChange={(e) => setDuration((d) => ({ ...d, mm: e.target.value }))}
              min="0"
              inputMode="numeric"
              className="mt-1 px-2 py-2 border border-slate-300 rounded w-24"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-slate-500">Seconds</span>
            <input
              type="number"
              value={duration.ss}
              onChange={(e) => setDuration((d) => ({ ...d, ss: e.target.value }))}
              min="0"
              max="59"
              inputMode="numeric"
              className="mt-1 px-2 py-2 border border-slate-300 rounded w-24"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-slate-500">Banner message (optional)</span>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. Round 1"
              className="mt-1 px-2 py-2 border border-slate-300 rounded"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onStart}
              className="bg-slate-900 text-white py-2 px-4 rounded font-medium"
            >
              Set &amp; Start
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

function UndoBanner({
  onUndo,
  expires,
}: {
  onUndo: () => void;
  expires: number;
}) {
  const [remaining, setRemaining] = useState(
    Math.max(0, Math.ceil((expires - Date.now()) / 1000)),
  );
  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((expires - Date.now()) / 1000)));
    }, 500);
    return () => window.clearInterval(id);
  }, [expires]);
  if (remaining <= 0) return null;
  return (
    <div className="bg-slate-900 text-white rounded-xl px-4 py-3 flex items-center justify-between">
      <span className="text-sm">
        Timer set. Undo ({remaining}s)
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="bg-white/10 hover:bg-white/20 px-3 py-1 rounded text-sm font-medium"
      >
        Undo
      </button>
    </div>
  );
}

export { ADJUST_STEPS_MIN };
