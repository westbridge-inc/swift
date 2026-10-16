'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSessionPrincipal, subscribeSession } from '@/lib/auth';
import { AGREEMENT_LINKS, acceptLegal, getLegalAcceptance, type LegalAcceptance } from '@/lib/legal-acceptance';

/**
 * [Legal research G2 · R26 · Terms "Changes"] When the legal texts change materially, a signed-in person is shown
 * what changed and asked to accept with a fresh, unticked tick before carrying on. "Continued use" is not
 * acceptance. They may instead stop and delete their account. Guests see nothing; the server decides who is asked.
 */
export function LegalAcceptanceGate() {
  const [principal, setPrincipal] = useState<string | null>(() => getSessionPrincipal());
  const [status, setStatus] = useState<LegalAcceptance | null>(null);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeSession(() => setPrincipal(getSessionPrincipal())), []);
  useEffect(() => {
    setStatus(null); setTicked(false); setError(null);
    if (!principal) return;
    let cancelled = false;
    getLegalAcceptance().then((s) => { if (!cancelled) setStatus(s); }).catch(() => { /* not signed in, or offline: ask next time */ });
    return () => { cancelled = true; };
  }, [principal]);

  if (!status?.needsAcceptance) return null;

  const accept = async () => {
    if (!ticked || busy) return;
    setBusy(true); setError(null);
    try {
      setStatus(await acceptLegal(status.currentVersion));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through. Please try again.');
      // The words may have changed while they read: show the new ones, unticked.
      getLegalAcceptance().then((s) => { setStatus(s); setTicked(false); }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="legal-accept-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 text-[var(--swift-ink)] shadow-xl">
        <h2 id="legal-accept-title" className="text-xl font-bold">
          {status.acceptedVersion ? 'We’ve updated our Terms' : 'Please accept our Terms'}
        </h2>
        {status.summary.length ? (
          <>
            <p className="mt-2 text-sm text-[var(--swift-muted)]">What changed:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm" data-testid="legal-accept-summary">
              {status.summary.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </>
        ) : null}
        <p className="mt-4 text-sm">
          Read the{' '}
          <Link href="/legal/terms" target="_blank" className="font-semibold underline">Terms of Service</Link>{' '}and the{' '}
          <Link href="/legal/privacy" target="_blank" className="font-semibold underline">Privacy Policy</Link>
          {status.agreements.map((a) => (
            <span key={a}>, and the <a href={AGREEMENT_LINKS[a].href} target="_blank" rel="noreferrer" className="font-semibold underline">{AGREEMENT_LINKS[a].label}</a></span>
          ))}.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>{acceptLabel(status)}</span>
        </label>
        {error ? <p role="alert" className="mt-3 text-sm text-[var(--swift-red)]">{error}</p> : null}
        <button type="button" onClick={() => void accept()} disabled={!ticked || busy} className="mt-5 w-full rounded-full bg-[var(--swift-red)] px-5 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Accept and continue'}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--swift-muted)]">
          If you do not accept, you can stop using Swift and{' '}
          <Link href="/account/delete" className="underline">delete your account</Link>.
        </p>
      </section>
    </div>
  );
}

/** The words beside the tick: every document the person accepts, by name. */
export function acceptLabel(s: Pick<LegalAcceptance, 'agreements' | 'acceptedVersion'>): string {
  const docs = ['Terms of Service', 'Privacy Policy', ...s.agreements.map((a) => AGREEMENT_LINKS[a].label)];
  const list = docs.length > 2 ? `${docs.slice(0, -1).join(', ')} and ${docs[docs.length - 1]}` : docs.join(' and ');
  return `I agree to the ${s.acceptedVersion ? 'updated ' : ''}${list}.`;
}
