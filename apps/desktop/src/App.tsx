import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clearSession, fetchOverview, globalSearch, loadSession, sendOtp, verifyAdminLogin,
} from './lib/api';

// ─── Login ───────────────────────────────────────────────────────────────────

function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setError(null); setBusy(true);
    try { await sendOtp(phone.trim()); setStep('code'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function verify() {
    setError(null); setBusy(true);
    try { await verifyAdminLogin(phone.trim(), code.trim()); onDone(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-80 rounded-2xl border border-white/10 bg-white/5 p-8">
        <p className="text-xl font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> Mission Control
        </p>
        <p className="mt-1 mb-6 text-sm text-white/50">
          {step === 'phone' ? 'Sign in with your admin phone.' : `Code sent to ${phone}.`}
        </p>
        {step === 'phone' ? (
          <>
            <input
              autoFocus value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="+592 600 1000"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm outline-none focus:border-[var(--swift-red)]"
            />
            <button
              onClick={send} disabled={busy || phone.trim().length < 6}
              className="mt-4 w-full rounded-lg bg-[var(--swift-red)] py-2.5 text-sm font-semibold disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            <input
              autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
              placeholder="000000"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm tracking-widest outline-none focus:border-[var(--swift-red)]"
            />
            <button
              onClick={verify} disabled={busy || code.trim().length < 4}
              className="mt-4 w-full rounded-lg bg-[var(--swift-red)] py-2.5 text-sm font-semibold disabled:opacity-40"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}
        {error && <p className="mt-3 text-sm text-[var(--swift-red)]">{error}</p>}
      </div>
    </div>
  );
}

// ─── ⌘K palette (global search over /admin/search) ──────────────────────────

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['cmdk', q],
    queryFn: () => globalSearch(q),
    enabled: open && q.trim().length >= 2,
  });

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  if (!open) return null;
  const d = search.data ?? {};
  const groups: Array<{ title: string; rows: Array<{ id: string; label: string; sub: string }> }> = [
    {
      title: 'Orders',
      rows: (d.orders ?? []).map((o: any) => ({
        id: o.id, label: `#${o.orderNumber}`, sub: `${o.status} · ${o.orderType}`,
      })),
    },
    {
      title: 'People',
      rows: (d.users ?? []).map((u: any) => ({
        id: u.id, label: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.phone, sub: u.phone,
      })),
    },
    {
      title: 'Vendors',
      rows: (d.vendors ?? []).map((v: any) => ({ id: v.id, label: v.name, sub: v.status })),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 pt-28" onClick={onClose}>
      <div
        className="mx-auto w-[560px] overflow-hidden rounded-xl border border-white/10 bg-[#161617] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Search orders, people, vendors…"
          className="w-full border-b border-white/10 bg-transparent px-4 py-3.5 text-sm outline-none"
        />
        <div className="max-h-96 overflow-auto p-2">
          {search.isFetching && <p className="px-3 py-2 text-sm text-white/40">Searching…</p>}
          {!search.isFetching && q.trim().length >= 2 && groups.every((g) => g.rows.length === 0) && (
            <p className="px-3 py-2 text-sm text-white/40">Nothing matches.</p>
          )}
          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <div key={g.title} className="mb-2">
                <p className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white/30">{g.title}</p>
                {g.rows.map((r) => (
                  <div key={r.id} className="rounded-lg px-3 py-2 hover:bg-white/5">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-white/40">{r.sub}</p>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Today (the morning briefing) ────────────────────────────────────────────

const money = (n: number) => `$${Math.round(Number(n ?? 0)).toLocaleString()}`;

function Tile({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${danger ? 'border-[var(--swift-red)]/50 bg-[var(--swift-red)]/10' : 'border-white/10 bg-white/5'}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-white/40">{label}</p>
      <p className="mt-2 text-3xl font-extrabold">{value}</p>
      {sub && <p className="mt-1 text-xs text-white/40">{sub}</p>}
    </div>
  );
}

function Today() {
  const q = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000 });

  if (q.isLoading) return <p className="text-sm text-white/40">Loading the briefing…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/60">Could not reach the admin API.</p>
        <p className="mt-1 text-xs text-white/30">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">
          Try again
        </button>
      </div>
    );
  }

  const d = q.data;
  const alerts = d.alerts ?? {};
  const alertCount = (alerts.pendingVendors ?? 0) + (alerts.pastDueSubs ?? 0) + (alerts.unassignedOrders ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4">
        <Tile label="Orders today" value={String(d.todayOrders ?? 0)} sub={`${d.todayCompletedOrders ?? 0} completed`} />
        <Tile label="On the road" value={String((d.activeRiders ?? 0) + (d.activeDrivers ?? 0))} sub={`${d.activeRiders} riders · ${d.activeDrivers} taxis`} />
        <Tile label="Weekly sub revenue" value={money(d.revenue?.weeklySubscriptionRevenue)} sub="platform revenue — subscriptions only" />
        <Tile label="Active vendors" value={String(d.activeVendors ?? 0)} sub={`${d.totalVendors ?? 0} total`} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Tile label="Vendors awaiting review" value={String(alerts.pendingVendors ?? 0)} danger={(alerts.pendingVendors ?? 0) > 0} />
        <Tile label="Past-due subscriptions" value={String(alerts.pastDueSubs ?? 0)} danger={(alerts.pastDueSubs ?? 0) > 0} />
        <Tile label="Orders needing attention" value={String(alerts.unassignedOrders ?? 0)} danger={(alerts.unassignedOrders ?? 0) > 0} />
      </div>
      <p className="text-xs text-white/30">
        {alertCount === 0 ? 'Nothing on fire. ' : `${alertCount} alert${alertCount === 1 ? '' : 's'} need eyes. `}
        Live since {new Date().toLocaleTimeString()} — refreshes every 30s. ⌘K to search anything.
      </p>
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [cmdk, setCmdk] = useState(false);

  useEffect(() => {
    loadSession().then((ok) => { setAuthed(ok); setReady(true); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdk((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = useMemo(
    () => async () => { await clearSession(); setAuthed(false); },
    [],
  );

  if (!ready) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 flex-col border-r border-white/10 p-4">
        <p className="px-2 text-base font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> MC
        </p>
        <nav className="mt-5 flex-1 space-y-0.5">
          <span className="block rounded-lg bg-[var(--swift-red)]/15 px-3 py-2 text-sm font-semibold text-[var(--swift-red)]">
            Today
          </span>
          {/* Further modules land per the build order — never stubbed (V1 mandate). */}
        </nav>
        <button
          onClick={() => setCmdk(true)}
          className="mb-2 rounded-lg border border-white/10 px-3 py-2 text-left text-sm text-white/50 hover:bg-white/5"
        >
          Search <span className="float-right text-xs">⌘K</span>
        </button>
        <button onClick={signOut} className="rounded-lg px-3 py-2 text-left text-sm text-white/50 hover:bg-white/5">
          Sign out
        </button>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <h1 className="mb-5 text-2xl font-extrabold">Today</h1>
        <Today />
      </main>
      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} />
    </div>
  );
}
