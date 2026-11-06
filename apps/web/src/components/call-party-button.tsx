'use client';

import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { CALLER_LINE_WORDS, CALL_WORDS, callChoice, callerLine as callerLineFor, fetchCallConfig, startSwiftCall, swiftContactCard, type CallConfig, type CallTarget } from '@/lib/call-bridge';

/**
 * [O-1] The Call control for one person on an order. Bridge OFF (the launch state): today's tel:
 * link on the number the API sent. Bridge ON: "Call via Swift" (Swift rings the signed-in person's
 * own phone first). Neither: nothing.
 */
export function CallPartyButton({ orderId, target, phone, label, className, noteClassName, icon = true, ariaLabel, callerLine = true }: {
  orderId: string | null | undefined;
  target: CallTarget;
  phone: string | null | undefined;
  label: string;
  className?: string;
  noteClassName?: string;
  /** The dashboard's Call is text only; the customer pages show the phone icon. */
  icon?: boolean;
  ariaLabel?: string;
  /** [CALL-RELAY-ON] Show "Swift calls you from …" under this button (false on a second button on the same page). */
  callerLine?: boolean;
}) {
  const [config, setConfig] = useState<CallConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchCallConfig().then((c) => { if (live) setConfig(c); });
    return () => { live = false; };
  }, []);
  const choice = callChoice(config, phone, orderId);
  if (choice.mode === 'none') return null;
  if (choice.mode === 'dial') {
    return (
      <a href={choice.href} className={className} aria-label={ariaLabel}>
        {icon ? <Phone size={18} aria-hidden="true" /> : null}{icon ? ' ' : null}{label}
      </a>
    );
  }
  const callerId = config?.callerId ?? null;
  const line = callerLine ? callerLineFor(callerId) : null;
  const card = line ? swiftContactCard(callerId) : null;
  return (
    <>
      <button
        type="button"
        className={className}
        // [REVIEW-F #2092 S4-3] two "Call via Swift" buttons on one page each say whom they call
        aria-label={ariaLabel ? `${ariaLabel} via Swift` : undefined}
        disabled={busy}
        onClick={async () => {
          if (!orderId || busy) return;
          setBusy(true);
          const out = await startSwiftCall(orderId, target);
          setNote(out.message);
          setBusy(false);
        }}
      >
        {icon ? <Phone size={18} aria-hidden="true" /> : null}{icon ? ' ' : null}{busy ? CALL_WORDS.calling : CALL_WORDS.viaSwift}
      </button>
      {note ? <p className={noteClassName} role="status">{note}</p> : null}
      {line && callerId ? <CallerLine line={line} callerId={callerId} card={card} className={noteClassName} /> : null}
    </>
  );
}

/**
 * [CALL-RELAY-ON · owner 6 Nov 2026] "So a call does not look like a scam": Guyana networks show only the
 * number, so the page says which number Swift calls from (the server's), with Copy and a contact card
 * ("Save contact" downloads Swift.vcf, made in the browser; a phone opens it in Contacts).
 */
function CallerLine({ line, callerId, card, className }: { line: string; callerId: string; card: string | null; className?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(callerId);
      setCopied(CALLER_LINE_WORDS.copied);
    } catch {
      setCopied(CALLER_LINE_WORDS.copyFailed);
    }
  };
  return (
    <p className={className}>
      <span className="select-all">{line}</span>{' '}
      <button type="button" className="font-semibold underline" aria-label={CALLER_LINE_WORDS.copyA11y} onClick={() => { void copy(); }}>
        {CALLER_LINE_WORDS.copy}
      </button>
      {card ? (
        <>
          {' · '}
          <a className="font-semibold underline" href={`data:text/vcard;charset=utf-8,${encodeURIComponent(card)}`} download="Swift.vcf" aria-label={CALLER_LINE_WORDS.saveA11y}>
            {CALLER_LINE_WORDS.save}
          </a>
        </>
      ) : null}
      {copied ? <span role="status"> {copied}</span> : null}
    </p>
  );
}
