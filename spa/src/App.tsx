import { Routes, Route, Link } from 'react-router-dom';

import { TimerPage } from './pages/Timer';
import { HelpPage } from './pages/Help';
import { LogPage } from './pages/Log';
import { SettingsPage } from './pages/Settings';
import { RoomsPage } from './pages/Rooms';
import { ProjectorPage } from './pages/Projector';

export function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <header style={{ marginBottom: '1rem' }}>
        <strong>TCA Timer</strong>
        <nav style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
          <Link to="/">Timer</Link>
          <Link to="/help">Help</Link>
          <Link to="/log">Log</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/rooms">Rooms</Link>
          <Link to="/projector">Projector</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<TimerPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/log" element={<LogPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/projector" element={<ProjectorPage />} />
        </Routes>
      </main>
    </div>
  );
}
