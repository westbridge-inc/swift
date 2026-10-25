'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, getStoreVat, sendVatCertificate, updateStoreVat, type StoreVatView } from '@/lib/vendor-api';
import { LEGAL_URL } from '@/lib/api';
import { storeKey } from '@/lib/store-scope';
import { GRA_VAT_URL } from '@/lib/store-vat-words';


const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/**
 * [STORE-VAT · owner O-5] The one line that says where the store's VAT stands, in the owner's words. Only an APPROVED
 * store whose VAT is in effect has VAT on its orders; every other state says plainly that nothing changed.
 */
export function vatStatusLine(v: StoreVatView): string {
  switch (v.status) {
    case 'NONE':
      return 'Not VAT-registered: your prices and receipts show no VAT.';
    case 'PENDING':
      return v.certificate
        ? 'Your certificate is waiting for a person at Swift to check it. Nothing has changed for your customers yet.'
        : 'Send your GRA VAT registration certificate below. A person at Swift checks it before anything changes.';
    case 'APPROVED':
      if (!v.effective) return 'Approved, but VAT is not on your orders right now. Your prices and receipts show no VAT.';
      return `Approved from ${day(v.approved?.effectiveFrom)}. Your prices include VAT at ${v.ratePercent}%, and receipts say “VAT charged by ${v.approved?.registeredName ?? ''} · VAT reg. no. ${v.approved?.number ?? ''}”.`;
    case 'REJECTED':
      return `Not approved${v.reviewNote ? `: ${v.reviewNote}` : ''}. Correct it and send your certificate again.`;
    case 'REVOKED':
      return `VAT withdrawn${v.reviewNote ? `: ${v.reviewNote}` : ''}. New orders carry no VAT.`;
  }
}

/**
 * [STORE-VAT · owner O-5] "Is your business VAT-registered with the GRA?" The owner's to answer (the API refuses anyone
 * else). No keeps (or takes) VAT off at once. Yes needs the VAT number exactly as the certificate shows it, and the
 * certificate itself; a person at Swift checks it, and only then do prices say "incl. VAT" and receipts name the store
 * as the one charging VAT. Prices are never changed here: they already include VAT ("add VAT at checkout" is not
 * offered yet). Hidden while Swift's VAT switch is off, unless the store already has a VAT record to show.
 */
export function VatCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const isOwner = (profile.data as { myRole?: string } | undefined)?.myRole === 'OWNER';
  const vat = useQuery({ queryKey: storeKey(storeId, 'vat'), queryFn: getStoreVat, enabled: isOwner });
  const v = vat.data;
  const [registered, setRegistered] = useState<boolean>(false);
  const [number, setNumber] = useState('');
  const [consent, setConsent] = useState(false);
  // [REVIEW-F #2087 S4] Turning off an APPROVED store's VAT ends the approval (a person must check again): ask once.
  const [confirmOff, setConfirmOff] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!v) return;
    setRegistered(v.status !== 'NONE');
    setNumber(v.vatRegistrationNumber ?? '');
  }, [v?.status, v?.vatRegistrationNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (data: StoreVatView) => {
    queryClient.setQueryData(storeKey(storeId, 'vat'), data);
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
  };
  const save = useMutation({
    mutationFn: (answer: boolean) => updateStoreVat(answer
      ? { registered: true, vatRegistrationNumber: number.trim(), mode: 'PRICES_INCLUDE_VAT' }
      : { registered: false }),
    onSuccess: (data) => { setConfirmOff(false); settle(data); },
  });
  const send = useMutation({
    mutationFn: (file: File) => sendVatCertificate(file),
    onSuccess: (data) => { setConsent(false); settle(data); },
  });

  if (!isOwner || !v || (!v.available && v.status === 'NONE')) return null;
  const claimed = v.status !== 'NONE';
  const numberChanged = number.trim() !== (v.vatRegistrationNumber ?? '');
  const canSave = registered ? number.trim().length > 0 && (!claimed || numberChanged) : claimed;
  const approved = v.status === 'APPROVED';
  const turnOff = () => (approved && !confirmOff ? setConfirmOff(true) : save.mutate(false));
  const confirmLine = confirmOff ? (
    <p role="alert" className="mt-2 text-sm">
      Turning VAT off ends your approval: your prices stop saying &ldquo;incl. VAT&rdquo; at once, and a person at Swift must
      check your certificate again before VAT can come back. Press the button again to turn it off.
    </p>
  ) : null;
  const needsCertificate = v.available && (v.status === 'PENDING' || v.status === 'REJECTED' || v.status === 'REVOKED')
    && (!v.certificate || v.certificate.status !== 'PENDING');

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">VAT</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Only a business registered for VAT with the GRA may charge VAT. If yours is not, keep this at No: your prices stay
        exactly as you type them.{' '}
        <a href={GRA_VAT_URL} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">VAT at the GRA</a>
      </p>
      <p className="mt-3 text-sm font-medium" role="status">{vatStatusLine(v)}</p>

      {v.available ? (
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold">Is your business VAT-registered with the GRA?</legend>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="vat-registered" checked={!registered} onChange={() => setRegistered(false)} className="accent-[var(--swift-red)]" />
              No
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="vat-registered" checked={registered} onChange={() => { setRegistered(true); setConfirmOff(false); }} className="accent-[var(--swift-red)]" />
              Yes
            </label>
          </div>
          {registered && (
            <div className="mt-3 space-y-2">
              <label htmlFor="vat-number" className="block text-sm font-semibold">VAT registration number (exactly as on your GRA certificate)</label>
              <input
                id="vat-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                inputMode="numeric"
                maxLength={40}
                className="w-full max-w-xs rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
              />
              <p className="text-sm">
                Your prices: <span className="font-semibold">my prices already include VAT ({v.ratePercent}%)</span>. Customers pay
                the prices you type; receipts show the VAT inside them. Adding VAT at checkout is not available yet.
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => (registered ? save.mutate(true) : turnOff())}
            disabled={!canSave || save.isPending}
            className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : registered ? 'Save and send for checking' : 'Turn VAT off'}
          </button>
          {!registered && confirmLine}
          {save.isError && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>}
        </fieldset>
      ) : (
        claimed && (
          <div className="mt-3">
            <p className="text-sm text-[var(--swift-muted)]">VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.</p>
            <button
              type="button"
              onClick={turnOff}
              disabled={save.isPending}
              className="mt-2 rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Turn VAT off
            </button>
            {confirmLine}
          </div>
        )
      )}

      {needsCertificate && !save.isPending && (
        <div className="mt-4 space-y-3 border-t border-[var(--swift-border)] pt-4">
          <p className="text-sm font-semibold">Your GRA VAT registration certificate</p>
          <p className="text-sm text-[var(--swift-muted)]">A photo or PDF of the certificate the GRA gave your business. A person at Swift checks the name, the VAT number and the date it starts.</p>
          <label className="flex items-start gap-2 text-xs text-[var(--swift-muted)]">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
            <span>
              I consent to Swift processing this document for verification, per the{' '}
              <a href={LEGAL_URL('privacy')} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">privacy notice</a>.
              It is stored encrypted and shared only as the Privacy Policy explains.
            </span>
          </label>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!consent || send.isPending}
            className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {send.isPending ? 'Sending…' : 'Choose the certificate'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            aria-label="VAT certificate file"
            disabled={send.isPending}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) send.mutate(file);
            }}
          />
          {send.isError && <p role="alert" className="text-sm text-[var(--swift-red)]">{(send.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}
