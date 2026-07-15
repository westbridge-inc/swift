'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDriverProfile, getRiderProfile, updateDriverProfile } from '@/lib/mover-api';

export default function AccountPage() {
  const queryClient = useQueryClient();
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile, retry: 0 });

  const user = ((driver.data?.['user'] ?? rider.data?.['user']) ?? null) as
    | { firstName?: string; lastName?: string; phone?: string }
    | null;

  const [mmg, setMmg] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const current = driver.data?.['mmgPayUrl'];
    if (typeof current === 'string') setMmg(current);
  }, [driver.data]);

  const save = useMutation({
    mutationFn: () => updateDriverProfile({ mmgPayUrl: mmg.trim() || null }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2500);
      queryClient.invalidateQueries({ queryKey: ['p-driver'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  if (rider.isLoading || driver.isLoading) return <p className="text-sm text-[var(--swift-muted)]">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-extrabold">Account</h1>

      {user && (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="text-lg font-bold">{[user.firstName, user.lastName].filter(Boolean).join(' ')}</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{user.phone}</p>
          <p className="mt-3 text-xs text-[var(--swift-muted)]">
            Name, photo and vehicle details are managed in the Swift app (changes go through review).
          </p>
        </div>
      )}

      {driver.data && (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="font-bold">Your MMG pay link (taxi)</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            Riders who choose MMG pay this link at the end of a trip — the money goes straight to you.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={mmg}
              onChange={(e) => setMmg(e.target.value)}
              placeholder="https://pay.mmg.gy/…"
              className="min-w-64 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
            />
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-sm font-medium text-green-600">Saved ✓</span>}
          </div>
          {error && <p className="mt-2 text-sm text-[var(--swift-red)]">{error}</p>}
        </div>
      )}

      <div className="rounded-2xl bg-[var(--swift-subtle)] p-5 text-sm text-[var(--swift-muted)]">
        <p className="font-semibold text-[var(--swift-ink)]">Why some things live in the app</p>
        <p className="mt-1">
          Going online, accepting jobs and navigation need GPS and notifications, so they stay on your phone.
          This portal is for the paperwork: earnings, history and documents.
        </p>
      </div>
    </div>
  );
}
