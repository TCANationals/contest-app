import { CountdownWithBorder } from '../components/CountdownWithBorder';

export function ProjectorPage() {
  // TODO(§10.5): full-screen projector view, cursor auto-hide, fullscreen API.
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <CountdownWithBorder status="idle" remainingMs={null} />
    </div>
  );
}
