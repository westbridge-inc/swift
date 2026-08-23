import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clearSession, globalSearch, loadSession, revokeSession, sendOtp, verifyAdminLogin,
} from './lib/api';
import ReviewCenter from './modules/ReviewCenter';
import LiveOps from './modules/LiveOps';
import AgentDesk from './modules/AgentDesk';
import Compliance from './modules/Compliance';
import Home from './modules/Home';
import Moderation from './modules/Moderation';
import Support from './modules/Support';
import StuckOrders from './modules/StuckOrders';
import Money from './modules/Money';
import People from './modules/People';
import Vendors from './modules/Vendors';
import Health from './modules/Health';

// ─── Login ───────────────────────────────────────────────────────────────────

function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Strip ALL whitespace so a typed/pasted "+592 600 1000" matches the stored
  // E.164 "+5926001000" — and only digits from the code.
  const cleanPhone = () => phone.replace(/\s+/g, '');
  const cleanCode = () => code.replace(/\D+/g, '');

  async function send() {
    setError(null); setBusy(true);
    try { await sendOtp(cleanPhone()); setStep('code'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function verify() {
    setError(null); setBusy(true);
    try { await verifyAdminLogin(cleanPhone(), cleanCode()); onDone(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-80 rounded-2xl border border-neutral-200 bg-neutral-100 p-8">
        <p className="text-xl font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> Mission Control
        </p>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          {step === 'phone' ? 'Sign in with your admin phone.' : `Code sent to ${phone}.`}
        </p>
        {step === 'phone' ? (
          <>
            <input
              autoFocus value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="+592 600 1000"
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none focus:border-[var(--swift-red)]"
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
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm tracking-widest outline-none focus:border-[var(--swift-red)]"
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

// [WR-024] Result rows navigate — they were hover-styled inert divs.
function CommandPalette({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: (m: 'stuck' | 'people' | 'vendors') => void }) {
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
  const groups: Array<{ title: string; to: 'stuck' | 'people' | 'vendors'; rows: Array<{ id: string; label: string; sub: string }> }> = [
    {
      title: 'Orders',
      to: 'stuck',
      rows: (d.orders ?? []).map((o: any) => ({
        id: o.id, label: `#${o.orderNumber}`, sub: `${o.status} · ${o.orderType}`,
      })),
    },
    {
      title: 'People',
      to: 'people',
      rows: (d.users ?? []).map((u: any) => ({
        id: u.id, label: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.phone, sub: u.phone,
      })),
    },
    {
      title: 'Vendors',
      to: 'vendors',
      rows: (d.vendors ?? []).map((v: any) => ({ id: v.id, label: v.name, sub: v.status })),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 pt-28" onClick={onClose}>
      <div
        className="mx-auto w-[560px] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Search orders, people, vendors…"
          className="w-full border-b border-neutral-200 bg-transparent px-4 py-3.5 text-sm outline-none"
        />
        <div className="max-h-96 overflow-auto p-2">
          {search.isFetching && <p className="px-3 py-2 text-sm text-neutral-400">Searching…</p>}
          {!search.isFetching && q.trim().length >= 2 && groups.every((g) => g.rows.length === 0) && (
            <p className="px-3 py-2 text-sm text-neutral-400">Nothing matches.</p>
          )}
          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <div key={g.title} className="mb-2">
                <p className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-neutral-400">{g.title}</p>
                {g.rows.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => { onGo(g.to); onClose(); }}
                    className="block w-full rounded-lg px-3 py-2 text-left hover:bg-neutral-100"
                  >
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-neutral-400">{r.sub}</p>
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [module, setModule] = useState<'today' | 'review' | 'ops' | 'stuck' | 'money' | 'support' | 'people' | 'vendors' | 'agent' | 'moderation' | 'compliance' | 'health'>('today');

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
    () => async () => {
      // [WR-018] Revoke server-side FIRST, then clear local secrets; a failed
      // revoke is said out loud, never silently ignored.
      const revoked = await revokeSession();
      await clearSession();
      setAuthed(false);
      if (!revoked) {
        alert('Signed out on this device, but the server session could not be revoked (offline?). It stays valid until it expires — sign in again later to rotate it.');
      }
    },
    [],
  );

  if (!ready) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 flex-col border-r border-neutral-200 p-4">
        <p className="px-2 text-base font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> MC
        </p>
        <nav className="mt-5 flex-1 space-y-0.5">
          {([['today', 'Today'], ['review', 'Review'], ['ops', 'Live Ops'], ['stuck', 'Stuck'], ['money', 'Money'], ['support', 'Support'], ['people', 'People'], ['vendors', 'Vendors'], ['agent', 'Agent'], ['moderation', 'Reports'], ['compliance', 'Compliance'], ['health', 'Health']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setModule(key)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold ${module === key ? 'bg-[var(--swift-red)]/15 text-[var(--swift-red)]' : 'text-neutral-600 hover:bg-neutral-100'}`}
            >
              {label}
            </button>
          ))}
          {/* Further modules land per the build order — never stubbed (V1 mandate). */}
        </nav>
        <button
          onClick={() => setCmdk(true)}
          className="mb-2 rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-100"
        >
          Search <span className="float-right text-xs">⌘K</span>
        </button>
        <button onClick={signOut} className="rounded-lg px-3 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-100">
          Sign out
        </button>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <h1 className="mb-5 text-2xl font-extrabold">
          {{ today: 'Today', review: 'Review Center', ops: 'Live Ops', stuck: 'Stuck Orders', money: 'Money', support: 'Support', people: 'People', vendors: 'Vendors & Billing', agent: 'Agent approvals', moderation: 'Reports', compliance: 'Compliance', health: 'Health' }[module]}
        </h1>
        {module === 'today' && <Home go={setModule} />}
        {module === 'review' && <ReviewCenter />}
        {module === 'ops' && <LiveOps />}
        {module === 'agent' && <AgentDesk />}
        {module === 'stuck' && <StuckOrders />}
        {module === 'money' && <Money />}
        {module === 'support' && <Support />}
        {module === 'moderation' && <Moderation />}
        {module === 'compliance' && <Compliance />}
        {module === 'people' && <People />}
        {module === 'vendors' && <Vendors />}
        {module === 'health' && <Health />}
      </main>
      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} onGo={setModule} />
    </div>
  );
}
