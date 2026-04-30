import { formatCountdown } from './format';

export function Overlay() {
  // TODO(§9.2): render CountdownWithBorder, priority colors, paused pill.
  return (
    <div
      style={{
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '48px',
        color: '#888',
        WebkitTextStroke: '2px #000',
        textAlign: 'center',
        padding: '1rem',
      }}
    >
      {formatCountdown(null)}
    </div>
  );
}
