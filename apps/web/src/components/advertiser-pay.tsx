'use client';
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { startAdCheckout } from '@/lib/partner-api';
import { ApiRequestError } from '@/lib/auth';

// [ADS-ON · owner ruling, 3 Nov] An advertiser pays on MMG's checkout page. The server decides whether an invoice can
// be paid and for how much, and it is paid only after MMG's own lookup confirms: this page hands the advertiser to
// MMG, and never reads "paid" from anywhere but the server. One key per invoice on this page, so a retry of the same
// tap can never open a second page.

const CONFIRMING = 'An earlier payment is being confirmed. Do not pay again.';

export function PayInvoice({ invoiceId }: { invoiceId: string }) {
  const key = useRef<string | null>(null);
  const [words, setWords] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const pay = useMutation({
    mutationFn: () => startAdCheckout(invoiceId, (key.current ??= crypto.randomUUID())),
    onMutate: () => setWords(null),
    onSuccess: (started) => {
      if (started.status === 'OPEN' && started.checkoutUrl !== null) window.location.assign(started.checkoutUrl);
      else { setConfirming(true); setWords(CONFIRMING); }
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && (error.code === 'PAYMENT_CONFIRMING' || error.code === 'CHECKOUT_CONFIRMING')) { setConfirming(true); setWords(CONFIRMING); }
      else setWords('MMG could not be opened. Try again in a minute.');
    },
  });
  return (
    <div className="w-full">
      {!confirming && <button type="button" className="sw-btn sw-btn-md" disabled={pay.isPending} onClick={() => pay.mutate()}>Pay with MMG</button>}
      {words && <p role="alert" className="sw-caption mt-2">{words}</p>}
    </div>
  );
}
