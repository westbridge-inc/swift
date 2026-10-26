'use client';

import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { CALL_WORDS, callChoice, fetchCallConfig, saveNumberTip, startSwiftCall, type CallConfig, type CallTarget } from '@/lib/call-bridge';

/**
 * [O-1] The Call control for one person on an order. Bridge OFF (the launch state): today's tel:
 * link on the number the API sent. Bridge ON: "Call via Swift" (Swift rings the signed-in person's
 * own phone first). Neither: nothing.
 */
export function CallPartyButton({ orderId, target, phone, label, className, noteClassName, icon = true, ariaLabel }: {
  orderId: string | null | undefined;
  target: CallTarget;
  phone: string | null | undefined;
  label: string;
  className?: string;
  noteClassName?: string;
  /** The dashboard's Call is text only; the customer pages show the phone icon. */
  icon?: boolean;
  ariaLabel?: string;
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
  const tip = saveNumberTip(config?.callerId);
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
      {tip ? <p className={noteClassName}>{tip}</p> : null}
    </>
  );
}
