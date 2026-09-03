'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelPendingMmgPayUrl, getDriverProfile, getRiderProfile, updateDriverProfile } from '@/lib/mover-api';

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

  // [W-31] A new pay link is STAGED behind a cool-off with the OLD one still
  // taking money (ALG-34), and the portal said "Saved ✓". A driver changed
  // where their earnings go, was told it worked, and kept being paid into the
  // previous account for hours without a word on screen. The API has always
  // returned all three of these; nothing rendered them.
  const liveUrl = (driver.data?.['mmgPayUrl'] as string | null) ?? null;
  const pendingUrl = (driver.data?.['mmgPayUrlPending'] as string | null) ?? null;
  const applyAtRaw = driver.data?.['mmgPayUrlApplyAt'] as string | null | undefined;
  const applyAt = applyAtRaw ? new Date(applyAtRaw) : null;

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

  const cancelPending = useMutation({
    mutationFn: cancelPendingMmgPayUrl,
    onSuccess: () => { setError(null); queryClient.invalidateQueries({ queryKey: ['p-driver'] }); },
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

          {/* [W-31] WHERE THE MONEY GOES RIGHT NOW, as a statement rather than
              a prefilled box the driver may have already typed over. */}
          <p className="mt-3 text-sm">
            <span className="text-[var(--swift-muted)]">Paying into now: </span>
            {liveUrl
              ? <span className="font-semibold break-all">{liveUrl}</span>
              : <span className="font-semibold">no link set — riders cannot pay you by MMG</span>}
          </p>

          {/* [W-31] A staged change is money that has NOT moved yet. Saying
              "Saved ✓" and nothing else let a driver believe it had. */}
          {pendingUrl && (
            <div role="status" className="mt-3 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-sm">
              <p className="font-semibold text-amber-800">A new link is waiting — your money has NOT moved yet</p>
              <p className="mt-1 break-all text-amber-900">{pendingUrl}</p>
              <p className="mt-1 text-amber-900">
                {applyAt
                  ? `It takes over at ${applyAt.toLocaleString()}. Until then every payment still goes to the link above.`
                  : 'Until it takes over, every payment still goes to the link above.'}
              </p>
              <button
                onClick={() => { if (window.confirm('Cancel this pending change and sign out your other devices?')) cancelPending.mutate(); }}
                disabled={cancelPending.isPending}
                className="mt-2 rounded-lg border border-amber-600 px-3 py-1.5 text-xs font-semibold text-amber-900 disabled:opacity-50"
              >
                {cancelPending.isPending ? 'Cancelling…' : 'This wasn’t me — cancel it'}
              </button>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={mmg}
              onChange={(e) => setMmg(e.target.value)}
              placeholder="https://pay.mmg.gy/…"
              className="min-w-64 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
            />
            <button
              onClick={() => {
                // [W-31] Changing where your earnings land is not a field edit.
                const next = mmg.trim();
                const question = next
                  ? `Send your future MMG payments to:\n\n${next}\n\nThis replaces ${liveUrl ?? 'no current link'} after a short safety delay.`
                  : 'Remove your MMG pay link? Riders will no longer be able to pay you by MMG.';
                if (window.confirm(question)) save.mutate();
              }}
              disabled={save.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {/* [W-31] Honest either way: a staged change is not a done one. */}
            {saved && (
              <span className="text-sm font-medium text-green-600">
                {pendingUrl ? 'Staged — it takes over after the safety delay' : 'Saved ✓'}
              </span>
            )}
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
