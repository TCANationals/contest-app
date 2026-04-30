// Shared border renderer (§9.2.4, §10.5).
// TODO: inverse-color outline per the priority table in §9.2.

export interface CountdownWithBorderProps {
  status: 'idle' | 'running' | 'paused';
  remainingMs: number | null;
}

export function CountdownWithBorder({
  status,
  remainingMs,
}: CountdownWithBorderProps) {
  const text =
    status === 'idle' || remainingMs == null ? '--:--' : formatMs(remainingMs);
  return (
    <span
      style={{
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '8vw',
        WebkitTextStroke: '2px black',
      }}
    >
      {text}
    </span>
  );
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
