import { useMemo } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppLayout } from './components/AppLayout';
import { HelpPage } from './pages/Help';
import { LogPage } from './pages/Log';
import { ProjectorPage } from './pages/Projector';
import { RoomsPage } from './pages/Rooms';
import { SettingsPage } from './pages/Settings';
import { TimerPage } from './pages/Timer';

export function App() {
  const location = useLocation();
  const roomParam = useMemo(
    () => new URLSearchParams(location.search).get('room'),
    [location.search],
  );

  // Projector is chrome-less (§10.5).
  if (location.pathname === '/projector') {
    return (
      <Routes>
        <Route path="/projector" element={<ProjectorPage />} />
      </Routes>
    );
  }

  return (
    <AppLayout room={roomParam}>
      <Routes>
        <Route path="/" element={<TimerPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/log" element={<LogPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
