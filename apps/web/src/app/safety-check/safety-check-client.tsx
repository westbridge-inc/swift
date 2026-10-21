'use client';

import { useEffect, useState } from 'react';
import { SwiftLogo } from '@/components/swift-logo';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

/** Guyana's police line — the same number the trip page's SOS calls. */
const POLICE_NUMBER = '911';

type Link = { ref: string; secret: string };
type State =
  | { kind: 'asking' }
  | { kind: 'sending'; response: 'OK' | 'NEED_HELP' }
  | { kind: 'ok' }
  | { kind: 'helped' }
  | { kind: 'closed' }
  | { kind: 'failed'; response: 'OK' | 'NEED_HELP' };

/** The link's `#<check>.<secret>`; anything else is no link at all. */
export function parseSafetyCheckLink(hash: string): Link | null {
  const m = /^#?([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,64})$/.exec(hash.trim());
  return m ? { ref: m[1]!, secret: m[2]! } : null;
}

export function SafetyCheckClient() {
  const [link, setLink] = useState<Link | null | undefined>(undefined);
  const [state, setState] = useState<State>({ kind: 'asking' });

  useEffect(() => {
    setLink(parseSafetyCheckLink(window.location.hash));
  }, []);

  async function send(response: 'OK' | 'NEED_HELP') {
    if (!link || state.kind === 'sending') return;
    setState({ kind: 'sending', response });
    try {
      const res = await fetch(`${API_URL}/api/v1/safety/public/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...link, response }),
        cache: 'no-store',
      });
      if (res.ok) setState(response === 'OK' ? { kind: 'ok' } : { kind: 'helped' });
      else if (res.status === 404) setState({ kind: 'closed' });
      else setState({ kind: 'failed', response });
    } catch {
      setState({ kind: 'failed', response });
    }
  }

  const sending = state.kind === 'sending';
  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-[var(--swift-canvas)] text-[var(--swift-ink)]">
      <header className="border-b border-[var(--swift-border)] bg-[var(--swift-card)] px-6 pb-4 pt-[calc(16px_+_env(safe-area-inset-top))]">
        <div className="mx-auto max-w-md">
          <SwiftLogo />
          <p className="sw-eyebrow mt-3">Swift · Trip Guardian</p>
        </div>
      </header>

      <div className="mx-auto flex max-w-md flex-col gap-4 px-4 pb-12 pt-8">
        {link === undefined ? null : link === null ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="sw-heading">This safety check link is not complete</p>
            <p className="sw-caption">Open the whole link from the text message, or answer on your trip page in Swift. If you are in danger, call {POLICE_NUMBER}.</p>
            <a href={`tel:${POLICE_NUMBER}`} className="sw-btn sw-btn-block">Call {POLICE_NUMBER}</a>
          </div>
        ) : state.kind === 'ok' ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="sw-heading">Thanks — Swift has your answer</p>
            <p className="sw-caption">Trip Guardian keeps watching your trip and will check in again if something changes.</p>
          </div>
        ) : state.kind === 'helped' ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="sw-heading">Swift’s safety team has been alerted</p>
            <p className="sw-caption">Call the police now if you can. Stay on the line with them.</p>
            <a href={`tel:${POLICE_NUMBER}`} className="sw-btn sw-btn-block">Call {POLICE_NUMBER}</a>
          </div>
        ) : state.kind === 'closed' ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="sw-heading">This safety check is already closed</p>
            <p className="sw-caption">It was answered, ended with the trip, or the link is not valid. If you are in danger, call {POLICE_NUMBER}.</p>
            <a href={`tel:${POLICE_NUMBER}`} className="sw-btn sw-btn-block">Call {POLICE_NUMBER}</a>
          </div>
        ) : (
          <section aria-labelledby="safety-check-title" className="flex flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
            <h1 id="safety-check-title" className="sw-heading">Everything okay?</h1>
            <p className="sw-caption">Swift’s Trip Guardian checks in when a trip pauses or changes route. Your driver can’t see your answer.</p>
            <button type="button" className="sw-btn sw-btn-block" disabled={sending} onClick={() => void send('OK')}>
              {sending && state.response === 'OK' ? 'Sending…' : 'I’m okay'}
            </button>
            <button type="button" className="sw-btn sw-btn-outline sw-btn-block" disabled={sending} onClick={() => void send('NEED_HELP')}>
              {sending && state.response === 'NEED_HELP' ? 'Alerting Swift…' : 'I need help'}
            </button>
            {state.kind === 'failed' && (
              <div role="alert" className="sw-note sw-note-error flex-col items-start gap-1">
                {state.response === 'NEED_HELP' ? (
                  <>
                    <p className="font-semibold">Swift was NOT alerted — your answer didn’t send.</p>
                    <p>Call {POLICE_NUMBER} now, then try again.</p>
                  </>
                ) : (
                  <p>Couldn’t send that — check your connection and try again.</p>
                )}
              </div>
            )}
            <a href={`tel:${POLICE_NUMBER}`} className="sw-link-btn self-start">In danger? Call {POLICE_NUMBER}</a>
          </section>
        )}
      </div>
    </main>
  );
}
