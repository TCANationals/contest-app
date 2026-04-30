import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, type JudgePrefs } from '../api/client';

const WEEKDAYS: Array<{ bit: number; label: string }> = [
  { bit: 0, label: 'Sun' },
  { bit: 1, label: 'Mon' },
  { bit: 2, label: 'Tue' },
  { bit: 3, label: 'Wed' },
  { bit: 4, label: 'Thu' },
  { bit: 5, label: 'Fri' },
  { bit: 6, label: 'Sat' },
];

export function SettingsPage() {
  const [params] = useSearchParams();
  const room = params.get('room');
  const qc = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ['prefs'],
    queryFn: () => api.getPrefs(),
  });

  const [draft, setDraft] = useState<Partial<JudgePrefs>>({});
  useEffect(() => {
    if (prefsQuery.data && Object.keys(draft).length === 0) {
      setDraft({
        phoneE164: prefsQuery.data.phoneE164,
        emailAddress: prefsQuery.data.emailAddress,
        enabledRooms: prefsQuery.data.enabledRooms,
        quietHoursStart: prefsQuery.data.quietHoursStart,
        quietHoursEnd: prefsQuery.data.quietHoursEnd,
        quietHoursWeekdays: prefsQuery.data.quietHoursWeekdays,
        timezone: prefsQuery.data.timezone,
      });
    }
  }, [prefsQuery.data, draft]);

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<JudgePrefs>) => api.putPrefs(patch),
    onSuccess: (data) => {
      qc.setQueryData(['prefs'], data);
    },
  });

  const prefs = prefsQuery.data;
  const enabledRooms = draft.enabledRooms ?? prefs?.enabledRooms ?? [];

  const toggleRoomMembership = (roomId: string) => {
    const next = enabledRooms.includes(roomId)
      ? enabledRooms.filter((r) => r !== roomId)
      : [...enabledRooms, roomId];
    setDraft((d) => ({ ...d, enabledRooms: next }));
  };

  const toggleWeekday = (bit: number) => {
    const mask = draft.quietHoursWeekdays ?? prefs?.quietHoursWeekdays ?? 0;
    const next = (mask ^ (1 << bit)) & 0x7f;
    setDraft((d) => ({ ...d, quietHoursWeekdays: next }));
  };

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500">
          Notification preferences are per-judge; room settings apply to{' '}
          <span className="font-mono">{room ?? '—'}</span>.
        </p>
      </div>

      {prefsQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {prefsQuery.isError && (
        <p className="text-sm text-red-600">
          Failed to load preferences: {(prefsQuery.error as Error).message}
        </p>
      )}

      {prefs && (
        <>
          <SettingsCard title="SMS">
            <StatusRow label="Status" value={prefs.phoneStatus} />
            <label className="flex flex-col text-sm">
              <span className="text-slate-600">Phone (E.164, e.g. +15555550123)</span>
              <input
                type="tel"
                value={draft.phoneE164 ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, phoneE164: e.target.value || null }))
                }
                placeholder="+15555550123"
                className="mt-1 px-3 py-2 border border-slate-300 rounded"
              />
            </label>
            {prefs.phoneStatus === 'pending' && <VerifyControl kind="phone" />}
          </SettingsCard>

          <SettingsCard title="Email">
            <StatusRow label="Status" value={prefs.emailStatus} />
            <label className="flex flex-col text-sm">
              <span className="text-slate-600">Email address</span>
              <input
                type="email"
                value={draft.emailAddress ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, emailAddress: e.target.value || null }))
                }
                placeholder="you@example.com"
                className="mt-1 px-3 py-2 border border-slate-300 rounded"
              />
            </label>
            {prefs.emailStatus === 'pending' && <VerifyControl kind="email" />}
          </SettingsCard>

          <SettingsCard title="Quiet hours">
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="flex flex-col text-sm">
                <span className="text-slate-600">Start (HH:MM)</span>
                <input
                  type="time"
                  value={draft.quietHoursStart ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, quietHoursStart: e.target.value || null }))
                  }
                  className="mt-1 px-3 py-2 border border-slate-300 rounded"
                />
              </label>
              <label className="flex flex-col text-sm">
                <span className="text-slate-600">End (HH:MM; may be &lt; start for overnight)</span>
                <input
                  type="time"
                  value={draft.quietHoursEnd ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, quietHoursEnd: e.target.value || null }))
                  }
                  className="mt-1 px-3 py-2 border border-slate-300 rounded"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {WEEKDAYS.map((d) => {
                const mask = draft.quietHoursWeekdays ?? prefs.quietHoursWeekdays;
                const active = ((mask >> d.bit) & 1) === 1;
                return (
                  <button
                    type="button"
                    key={d.bit}
                    onClick={() => toggleWeekday(d.bit)}
                    className={`px-3 py-1 rounded-full text-xs border ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <label className="flex flex-col text-sm mt-2">
              <span className="text-slate-600">Timezone (IANA)</span>
              <input
                type="text"
                value={draft.timezone ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
                placeholder="America/Chicago"
                className="mt-1 px-3 py-2 border border-slate-300 rounded"
              />
            </label>
          </SettingsCard>

          <SettingsCard title="Notified rooms">
            <p className="text-xs text-slate-500">
              SMS + email notifications only fire for rooms selected here.
            </p>
            <div className="flex flex-wrap gap-1 mt-2">
              {(prefs.enabledRooms.length
                ? prefs.enabledRooms
                : (room ? [room] : [])
              ).map((r) => {
                const active = enabledRooms.includes(r);
                return (
                  <button
                    type="button"
                    key={r}
                    onClick={() => toggleRoomMembership(r)}
                    className={`px-3 py-1 rounded-full text-xs border font-mono ${
                      active
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    {r}
                  </button>
                );
              })}
              {room && !enabledRooms.includes(room) && (
                <button
                  type="button"
                  onClick={() => toggleRoomMembership(room)}
                  className="px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-700 border border-slate-300 font-mono"
                >
                  + {room}
                </button>
              )}
            </div>
          </SettingsCard>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(draft)}
              className="bg-slate-900 text-white px-4 py-2 rounded font-medium disabled:opacity-60"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save preferences'}
            </button>
            {saveMutation.isSuccess && (
              <span className="text-sm text-emerald-700">Saved.</span>
            )}
            {saveMutation.isError && (
              <span className="text-sm text-red-600">
                {(saveMutation.error as Error).message}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  const tone: Record<string, string> = {
    verified: 'bg-emerald-100 text-emerald-800',
    pending: 'bg-amber-100 text-amber-800',
    opted_out: 'bg-red-100 text-red-800',
    none: 'bg-slate-100 text-slate-700',
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-slate-600">{label}:</span>
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tone[value] ?? ''}`}>
        {value}
      </span>
    </div>
  );
}

function VerifyControl({ kind }: { kind: 'phone' | 'email' }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () =>
      kind === 'phone' ? api.verifyPhone(code) : api.verifyEmail(code),
    onSuccess: (res) => {
      setMsg(`Verified (${res.status})`);
      qc.invalidateQueries({ queryKey: ['prefs'] });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  return (
    <div className="flex gap-2 items-center mt-1">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="6-digit code"
        inputMode="numeric"
        maxLength={6}
        className="px-3 py-2 border border-slate-300 rounded font-mono w-32"
      />
      <button
        type="button"
        onClick={() => mut.mutate()}
        disabled={code.length !== 6}
        className="bg-emerald-600 text-white px-3 py-2 rounded text-sm font-medium disabled:opacity-50"
      >
        Verify
      </button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </div>
  );
}
