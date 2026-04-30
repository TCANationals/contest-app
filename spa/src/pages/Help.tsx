import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { sendFrame, useAppStore } from '../store';

/**
 * Empty→non-empty queue chime (§7.2).
 *
 * We intentionally synthesize the tone with the WebAudio API instead of
 * shipping a binary asset: it keeps the SPA dependency-free, avoids a 404
 * when the asset is missing, and gives a short, pleasant blip on any device
 * whose audio context we have the user-gesture permission to resume.
 */
function playChime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio blocked until user gesture — skip silently. */
  }
}

export function HelpPage() {
  const [params] = useSearchParams();
  const room = params.get('room');
  const queue = useAppStore((s) => s.helpQueue);
  const prevCount = useRef<number>(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!queue) return;
    const count = queue.entries.length;
    // §7.2: chime only on empty→non-empty transition; subsequent adds are silent.
    if (prevCount.current === 0 && count > 0) {
      playChime();
    }
    prevCount.current = count;
  }, [queue]);

  const rows = useMemo(() => queue?.entries ?? [], [queue]);

  if (!room) {
    return (
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">Help queue</h1>
        <p className="text-sm text-slate-600">Select a room first.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Help queue</h1>
          <p className="text-sm text-slate-500">
            Room <span className="font-mono">{room}</span>
            {queue && (
              <>
                {' • '}
                {rows.length} pending
              </>
            )}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-500">
          No one is waiting.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((entry) => (
            <HelpRow
              key={entry.contestantId}
              contestantId={entry.contestantId}
              stationNumber={entry.stationNumber}
              requestedAtServerMs={entry.requestedAtServerMs}
              expanded={!!expanded[entry.contestantId]}
              onToggle={() =>
                setExpanded((m) => ({
                  ...m,
                  [entry.contestantId]: !m[entry.contestantId],
                }))
              }
              onAck={() =>
                sendFrame({ type: 'HELP_ACK', contestantId: entry.contestantId })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface HelpRowProps {
  contestantId: string;
  stationNumber: number | null;
  requestedAtServerMs: number;
  expanded: boolean;
  onToggle: () => void;
  onAck: () => void;
}

function HelpRow({
  contestantId,
  stationNumber,
  requestedAtServerMs,
  expanded,
  onToggle,
  onAck,
}: HelpRowProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const waitMs = Math.max(0, Date.now() - requestedAtServerMs);
  return (
    <li className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full min-h-[56px] px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50"
        aria-expanded={expanded}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono font-semibold">{contestantId}</span>
            {stationNumber != null && (
              <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-0.5">
                Station {stationNumber}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            Waiting {formatWait(waitMs)}
          </div>
        </div>
        <span className="hidden sm:inline-block">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAck();
            }}
            className="bg-slate-900 text-white px-4 py-2 rounded-lg font-medium"
          >
            Acknowledge
          </button>
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 sm:hidden">
          <button
            type="button"
            onClick={onAck}
            className="w-full bg-slate-900 text-white py-3 rounded-lg font-medium"
          >
            Acknowledge
          </button>
        </div>
      )}
    </li>
  );
}

function formatWait(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
