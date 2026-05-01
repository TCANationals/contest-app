import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useJudgeSocket } from '../hooks/useWebSocket';
import { api } from '../api/client';
import { useAppStore } from '../store';
import { touchRecentRoom } from '../lib/rooms';
import { ConnectionPill } from './ConnectionPill';

interface AppLayoutProps {
  room: string | null;
  children: ReactNode;
}

const tabs = [
  { to: '/', label: 'Timer', icon: '⏱' },
  { to: '/help', label: 'Help', icon: '🆘' },
  { to: '/log', label: 'Log', icon: '📋' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function AppLayout({ room, children }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const connection = useAppStore((s) => s.connection);
  const timer = useAppStore((s) => s.timer);
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    if (room) touchRecentRoom(room);
  }, [room]);

  useJudgeSocket({ room, mintTicket: async () => (await api.mintTicket()).ticket });

  // `/api/auth/me` is the cheapest way to confirm the OIDC session
  // cookie is live; on 401 the api client redirects the browser to
  // /api/auth/login. The query is intentionally outside Suspense so
  // a slow IdP discovery on the server side doesn't block the timer.
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: 60_000,
    retry: false,
  });

  const onSwitchRoom = () => setShowRoomPicker((v) => !v);

  const withRoom = (path: string) => {
    if (!room) return path;
    const qs = new URLSearchParams(location.search);
    qs.set('room', room);
    return `${path}?${qs.toString()}`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 shadow-sm">
        <button
          type="button"
          onClick={onSwitchRoom}
          className="flex items-center gap-2 text-left"
          aria-haspopup="menu"
          aria-expanded={showRoomPicker}
        >
          <span className="font-bold tracking-tight">TCA Timer</span>
          <span className="text-slate-400">/</span>
          <span className="text-slate-700 font-mono text-sm max-w-[8rem] md:max-w-none truncate">
            {room ?? 'select room'}
          </span>
          <span className="text-slate-400 text-xs">▾</span>
        </button>
        <div className="ml-auto flex items-center gap-3">
          {timer?.connectedContestants != null && (
            <span className="hidden sm:inline text-xs text-slate-500">
              {timer.connectedContestants} overlays
            </span>
          )}
          <ConnectionPill status={connection} dbDegraded={timer?.dbDegraded} />
          <Link
            to={withRoom('/rooms')}
            className="hidden md:inline text-sm text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            Rooms
          </Link>
          {meQuery.data && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowUserMenu((v) => !v)}
                className="flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900"
                aria-haspopup="menu"
                aria-expanded={showUserMenu}
              >
                <span className="hidden sm:inline truncate max-w-[10rem]">
                  {meQuery.data.email || meQuery.data.sub}
                </span>
                <span aria-hidden="true" className="text-slate-400 text-xs">
                  ▾
                </span>
              </button>
              {showUserMenu && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-48 bg-white border border-slate-200 rounded shadow-md z-30"
                >
                  <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100">
                    <div className="truncate">{meQuery.data.email || '—'}</div>
                    <div className="truncate font-mono text-[10px]">
                      {meQuery.data.access === 'all'
                        ? 'admin (all rooms)'
                        : `${meQuery.data.access.length} room(s)`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowUserMenu(false);
                      void api.logout();
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {showRoomPicker && (
        <div
          role="menu"
          className="relative z-20 bg-white border-b border-slate-200 shadow-sm"
        >
          <div className="max-w-3xl mx-auto p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">
              Switch room
            </p>
            <button
              type="button"
              onClick={() => {
                setShowRoomPicker(false);
                navigate('/rooms');
              }}
              className="w-full text-left px-3 py-2 rounded bg-slate-100 hover:bg-slate-200"
            >
              Open full room list →
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-4 pb-24 md:pb-8">
        {!room && location.pathname !== '/rooms' ? (
          <NoRoomBanner />
        ) : (
          children
        )}
      </main>

      {/* Bottom tabbar: phone only (§10.3). */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 flex justify-around px-2"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.5rem)' }}
        aria-label="Primary"
      >
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={withRoom(t.to)}
            end={t.to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center py-2 text-xs ${
                isActive ? 'text-slate-900 font-semibold' : 'text-slate-500'
              }`
            }
          >
            <span aria-hidden="true" className="text-lg leading-none">
              {t.icon}
            </span>
            {t.label}
          </NavLink>
        ))}
      </nav>

      {/* Sidebar rail: tablet/desktop. */}
      <aside className="hidden md:flex md:fixed md:left-0 md:top-[4rem] md:bottom-0 md:w-48 md:border-r md:border-slate-200 md:bg-white md:flex-col md:p-4 md:gap-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={withRoom(t.to)}
            end={t.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded text-sm ${
                isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
              }`
            }
          >
            <span aria-hidden="true">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
        <div className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500">
          <Link to={withRoom('/rooms')} className="block py-1 hover:text-slate-900">
            Room picker
          </Link>
          <Link
            to={room ? `/projector?room=${encodeURIComponent(room)}` : '/projector'}
            target="_blank"
            rel="noopener"
            className="block py-1 hover:text-slate-900"
          >
            Projector ↗
          </Link>
        </div>
      </aside>

      {/* Offset the main content to make room for the sidebar on desktop. */}
      <style>{`@media (min-width: 768px) { main { margin-left: 12rem; } }`}</style>
    </div>
  );
}

function NoRoomBanner() {
  return (
    <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-4">
      <h1 className="font-semibold mb-1">No room selected</h1>
      <p className="text-sm mb-3">
        Pick a room to start. Your recently-used rooms are listed in MRU order.
      </p>
      <Link
        to="/rooms"
        className="inline-block bg-amber-900 text-white px-4 py-2 rounded text-sm font-medium"
      >
        Choose a room
      </Link>
    </div>
  );
}
