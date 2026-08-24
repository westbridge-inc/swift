import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clearSession,
  globalSearch,
  loadSession,
  revokeSession,
  sendOtp,
  setNativeOperatorMenuEnabled,
  verifyAdminLogin,
} from './lib/api';
import AgentDesk from './modules/AgentDesk';
import Compliance from './modules/Compliance';
import Health from './modules/Health';
import Home from './modules/Home';
import LiveOps from './modules/LiveOps';
import Moderation from './modules/Moderation';
import Money from './modules/Money';
import People from './modules/People';
import ReviewCenter from './modules/ReviewCenter';
import StuckOrders from './modules/StuckOrders';
import Support from './modules/Support';
import Vendors from './modules/Vendors';

type ModuleKey =
  | 'today'
  | 'review'
  | 'ops'
  | 'stuck'
  | 'money'
  | 'support'
  | 'people'
  | 'vendors'
  | 'agent'
  | 'moderation'
  | 'compliance'
  | 'health';

const MODULE_META: Record<ModuleKey, { title: string; subtitle: string }> = {
  today: { title: 'Today', subtitle: 'The live operating briefing' },
  review: { title: 'Document triage', subtitle: 'One file, one human decision at a time' },
  ops: { title: 'Live operations', subtitle: 'Movers, active work and exhausted searches' },
  stuck: { title: 'Stuck orders', subtitle: 'Delivery work outside its live SLA' },
  money: { title: 'Money', subtitle: 'Partner subscriptions and platform money truth' },
  support: { title: 'Support', subtitle: 'Open in-app requests' },
  people: { title: 'People', subtitle: 'Accounts and operating status' },
  vendors: { title: 'Businesses', subtitle: 'Partners, papers and subscriptions' },
  agent: { title: 'Agent desk', subtitle: 'The machine proposes; a person decides' },
  moderation: { title: 'Reports', subtitle: 'Content awaiting a moderation decision' },
  compliance: { title: 'Compliance', subtitle: 'Live gates, evidence and review cases' },
  health: { title: 'System health', subtitle: 'Queues, alerts and service state' },
};

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ key: ModuleKey; label: string; glyph: string }>;
}> = [
  {
    label: 'Command',
    items: [
      { key: 'today', label: 'Today', glyph: '⌂' },
      { key: 'review', label: 'Review', glyph: '▤' },
      { key: 'ops', label: 'Live ops', glyph: '↗' },
      { key: 'stuck', label: 'Stuck', glyph: '!' },
    ],
  },
  {
    label: 'Business',
    items: [
      { key: 'money', label: 'Money', glyph: '$' },
      { key: 'vendors', label: 'Businesses', glyph: '◆' },
      { key: 'people', label: 'People', glyph: '◉' },
    ],
  },
  {
    label: 'Trust & care',
    items: [
      { key: 'compliance', label: 'Compliance', glyph: '✓' },
      { key: 'moderation', label: 'Reports', glyph: '△' },
      { key: 'support', label: 'Support', glyph: '?' },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'agent', label: 'Agent desk', glyph: '✦' },
      { key: 'health', label: 'Health', glyph: '∿' },
    ],
  },
];

type SessionGateIssue = {
  mode: 'restore' | 'clear';
  message: string;
};

function SecureSessionGate({
  issue,
  busy,
  onRetry,
}: {
  issue: SessionGateIssue;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="login-shell">
      <section className="login-card session-gate-card" role="alert">
        <div className="brand-lockup login-brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span><strong>Swift</strong> Mission Control</span>
        </div>
        <p className="eyebrow">macOS Keychain</p>
        <h1>Secure session needs attention.</h1>
        <p className="login-copy">{issue.message}</p>
        <p className="session-gate-note">
          Mission Control will not open another admin session until this is resolved.
        </p>
        <button className="primary-button login-submit" disabled={busy} onClick={onRetry}>
          {busy ? 'Checking…' : issue.mode === 'clear' ? 'Retry secure removal' : 'Try Keychain again'}
        </button>
      </section>
    </main>
  );
}

function SigningOutGate() {
  return (
    <main className="login-shell" aria-live="polite">
      <section className="login-card session-gate-card">
        <div className="brand-lockup login-brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span><strong>Swift</strong> Mission Control</span>
        </div>
        <p className="eyebrow">Secure session</p>
        <h1>Signing out…</h1>
        <p className="login-copy">Operator controls are locked while Mission Control removes this Mac’s credentials.</p>
      </section>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitLock = useRef(false);

  const cleanPhone = () => phone.replace(/\s+/g, '');
  const cleanCode = () => code.replace(/\D+/g, '');
  const phoneReady = cleanPhone().length >= 6;
  const codeReady = cleanCode().length >= 4;

  async function send() {
    if (submitLock.current || !phoneReady) return;
    submitLock.current = true;
    setError(null);
    setBusy(true);
    try {
      await sendOtp(cleanPhone());
      setStep('code');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  async function verify() {
    if (submitLock.current || !codeReady) return;
    submitLock.current = true;
    setError(null);
    setBusy(true);
    try {
      await verifyAdminLogin(cleanPhone(), cleanCode());
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
      submitLock.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void (step === 'phone' ? send() : verify());
        }}
      >
        <div className="brand-lockup login-brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span><strong>Swift</strong> Mission Control</span>
        </div>
        <p className="eyebrow">Founder’s cockpit · macOS</p>
        <h1>{step === 'phone' ? 'Sign in to operate.' : 'Enter the code.'}</h1>
        <p className="login-copy">
          {step === 'phone' ? 'Use the phone number on your Swift admin account.' : `The one-time code was sent to ${phone}.`}
        </p>
        {step === 'phone' ? (
          <label className="login-field">
            <span>Admin phone</span>
            <input
              autoFocus
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+592 600 1000"
              autoComplete="tel"
            />
          </label>
        ) : (
          <label className="login-field">
            <span>One-time code</span>
            <input
              autoFocus
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              autoComplete="one-time-code"
            />
          </label>
        )}
        <button
          className="primary-button login-submit"
          type="submit"
          disabled={busy || (step === 'phone' ? !phoneReady : !codeReady)}
        >
          {busy ? (step === 'phone' ? 'Sending…' : 'Signing in…') : (step === 'phone' ? 'Send code' : 'Sign in')}
        </button>
        {step === 'code' && <button type="button" className="text-button" disabled={busy} onClick={() => { setStep('phone'); setError(null); }}>Use a different phone</button>}
        {error && <p className="login-error" role="alert">{error}</p>}
      </form>
    </main>
  );
}

function CommandPalette({
  open,
  onClose,
  onGo,
}: {
  open: boolean;
  onClose: () => void;
  onGo: (module: 'stuck' | 'people' | 'vendors') => void;
}) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useQuery({
    queryKey: ['cmdk', query],
    queryFn: () => globalSearch(query),
    enabled: open && query.trim().length >= 2,
  });

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => previousFocus?.focus({ preventScroll: true });
  }, [open]);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  const data = search.data ?? {};
  const groups: Array<{
    title: string;
    to: 'stuck' | 'people' | 'vendors';
    rows: Array<{ id: string; label: string; sub: string }>;
  }> = [
    {
      title: 'Orders',
      to: 'stuck',
      rows: (data.orders ?? []).map((order: any) => ({
        id: order.id,
        label: `#${order.orderNumber}`,
        sub: `${order.status} · ${order.orderType}`,
      })),
    },
    {
      title: 'People',
      to: 'people',
      rows: (data.users ?? []).map((user: any) => ({
        id: user.id,
        label: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.phone,
        sub: user.phone,
      })),
    },
    {
      title: 'Businesses',
      to: 'vendors',
      rows: (data.vendors ?? []).map((vendor: any) => ({ id: vendor.id, label: vendor.name, sub: vendor.status })),
    },
  ];
  const noResults = !search.isFetching && query.trim().length >= 2 && groups.every((group) => group.rows.length === 0);

  return (
    <div className="command-scrim" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input-wrap">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search orders, people and businesses"
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-results" aria-live="polite" aria-busy={search.isFetching}>
          {query.trim().length < 2 && <p className="command-hint">Type at least two characters. Results come from the admin search endpoint.</p>}
          {search.isFetching && <p className="command-hint">Searching…</p>}
          {search.isError && <p className="command-hint error">{(search.error as Error).message}</p>}
          {noResults && <p className="command-hint">Nothing matches.</p>}
          {groups.map((group) => group.rows.length === 0 ? null : (
            <div className="command-group" key={group.title}>
              <p>{group.title}</p>
              {group.rows.map((row) => (
                <button
                  key={row.id}
                  aria-label={`Open the ${group.title} list for search match ${row.label}`}
                  onClick={() => { onGo(group.to); onClose(); }}
                >
                  <span><strong>{row.label}</strong><small>{row.sub} · opens the {group.title.toLowerCase()} list</small></span>
                  <span aria-hidden="true">list ↵</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <footer>Search covers the records currently exposed by the admin API.</footer>
      </section>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [module, setModule] = useState<ModuleKey>('today');
  const [sessionIssue, setSessionIssue] = useState<SessionGateIssue | null>(null);
  const [sessionRetrying, setSessionRetrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void loadSession()
      .then((restored) => setAuthed(restored))
      .catch((error: unknown) => {
        setSessionIssue({
          mode: 'restore',
          message: (error as Error).message,
        });
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!authed || signingOut) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authed, signingOut]);

  useEffect(() => {
    if (!ready) return;
    void setNativeOperatorMenuEnabled(authed && !signingOut).catch((error: unknown) => {
      console.error('Could not update the native Mission Control menu.', error);
    });
  }, [authed, ready, signingOut]);

  useEffect(() => {
    if (!authed || signingOut || !('__TAURI_INTERNALS__' in window)) return undefined;
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<string>('mc-native-menu', (event) => {
        const destination: Record<string, ModuleKey> = {
          'mc:review': 'review',
          'mc:live-ops': 'ops',
          'mc:stuck': 'stuck',
          'mc:people': 'people',
          'mc:vendors': 'vendors',
        };
        if (event.payload === 'mc:search') setCommandOpen(true);
        else if (destination[event.payload]) {
          setCommandOpen(false);
          setModule(destination[event.payload]);
        }
      }))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListening = unlisten;
      })
      .catch((error: unknown) => {
        console.error('Could not connect the native Mission Control menu.', error);
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [authed, signingOut]);

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setCommandOpen(false);
    setAuthed(false);
    void setNativeOperatorMenuEnabled(false).catch((error: unknown) => {
      console.error('Could not lock the native Mission Control menu during sign-out.', error);
    });
    let revoked = false;
    try {
      await queryClient.cancelQueries();
      revoked = await revokeSession();
      await clearSession();
    } catch (error) {
      queryClient.clear();
      setCommandOpen(false);
      setAuthed(false);
      setSessionIssue({
        mode: 'clear',
        message: error instanceof Error
          ? error.message
          : 'Sign-out was interrupted before local credentials could be removed.',
      });
      setSigningOut(false);
      return;
    }
    queryClient.clear();
    setCommandOpen(false);
    setAuthed(false);
    setSigningOut(false);
    if (!revoked) {
      alert('Local Keychain credentials were removed, but the server did not confirm revocation. The remote session may remain valid until it expires.');
    }
  }, [queryClient, signingOut]);

  const retrySecureSession = async () => {
    if (!sessionIssue || sessionRetrying) return;
    setSessionRetrying(true);
    try {
      if (sessionIssue.mode === 'clear') {
        await clearSession();
        queryClient.clear();
        setAuthed(false);
      } else {
        const restored = await loadSession();
        setAuthed(restored);
      }
      setSessionIssue(null);
    } catch (error) {
      setSessionIssue({ ...sessionIssue, message: (error as Error).message });
    } finally {
      setSessionRetrying(false);
    }
  };

  if (!ready) return <div className="app-loading" aria-label="Loading Mission Control" />;
  if (sessionIssue) {
    return <SecureSessionGate issue={sessionIssue} busy={sessionRetrying} onRetry={() => void retrySecureSession()} />;
  }
  if (signingOut) return <SigningOutGate />;
  if (!authed) {
    return <Login onDone={() => { queryClient.clear(); setAuthed(true); }} />;
  }

  const meta = MODULE_META[module];
  const today = new Intl.DateTimeFormat('en-GY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Guyana',
  }).format(new Date());

  return (
    <>
      <div className="app-shell" inert={commandOpen} aria-hidden={commandOpen || undefined}>
        <aside className="mission-sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span><strong>Swift</strong><small>Mission Control</small></span>
        </div>
        <nav className="mission-nav" aria-label="Mission Control modules">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  className={module === item.key ? 'active' : ''}
                  aria-current={module === item.key ? 'page' : undefined}
                  onClick={() => setModule(item.key)}
                >
                  <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-actions">
          <button className="sidebar-search" onClick={() => setCommandOpen(true)}>
            <span>⌕</span>
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <button className="sidebar-signout" onClick={() => void signOut()}>Sign out</button>
        </div>
        </aside>

        <main className="mission-main">
        <header className="window-toolbar">
          <div>
            <h1>{meta.title}</h1>
            <p>{module === 'today' ? today : meta.subtitle}</p>
          </div>
          <button className="toolbar-search" onClick={() => setCommandOpen(true)}>
            <span aria-hidden="true">⌕</span>
            <span>Search everything</span>
            <kbd>⌘K</kbd>
          </button>
        </header>
        <div className={`module-content ${module === 'review' ? 'review-module' : ''}`}>
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
        </div>
        </main>
      </div>
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} onGo={setModule} />
    </>
  );
}
