'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CheckCircle2, ChevronDown, ChevronRight, Copy, ExternalLink, Maximize, PhoneOff, Share2, ShoppingBag } from 'lucide-react';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { getQr, getQrPublicState } from '@/lib/vendor-api';

/**
 * [STORE-LINK+NAMES · owner 30 Oct 21:47Z] "My QR & number" on the web business dashboard: the phone
 * app's screen (apps/mobile/src/modules/vendor/screens/VendorMyQrScreen.tsx), with its server reads
 * and its words. A store shares its Swift link with customers who message it (WhatsApp and the like):
 * the live code, the short link to copy, Share link and Open web menu. Nothing can be shared, copied
 * or opened until the public resolver confirms that the code opens THIS store, as on the phone.
 * The QR lifecycle controls and the scan figures stay on the phone for now.
 */

/** Placement tips — exactly the phone's six. */
const TIPS = [
  'On the counter by the till',
  'On your front door or window',
  'Inside every delivery bag',
  'On your WhatsApp status each week',
  'Pinned to your Facebook page',
  'On your menu or price list',
];

const STEPS = [
  { icon: Maximize, label: 'Customer scans' },
  { icon: ShoppingBag, label: 'Your store opens' },
  { icon: CheckCircle2, label: 'They order' },
];

type PublicState = 'checking' | 'live' | 'unavailable' | 'error';

const STATE_WORDS: Record<PublicState, string> = {
  live: 'Customers scan this to open your live web menu — no app install',
  checking: 'Checking whether this store link is live…',
  unavailable: 'This code is not taking customers to a live store yet.',
  error: "Swift couldn't confirm that this store link is live.",
};

function HowItWorks() {
  return (
    <section aria-label="How it works" className="sw-card flex flex-col items-center gap-3 p-5 sm:flex-row sm:justify-between sm:gap-0">
      {STEPS.map((step, i) => (
        <div key={step.label} className="contents">
          {i > 0 && (
            <>
              <ChevronDown size={16} aria-hidden="true" className="text-[var(--swift-muted)] sm:hidden" />
              <ChevronRight size={16} aria-hidden="true" className="hidden text-[var(--swift-muted)] sm:block" />
            </>
          )}
          <div className="flex flex-1 flex-col items-center text-center">
            <step.icon size={18} aria-hidden="true" className="text-[var(--swift-red)]" />
            <p className="sw-caption mt-1">{step.label}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

export default function StoreQrPage() {
  const storeId = useStoreId();
  const { manager, known } = useStoreRole();
  // The phone re-reads the code every minute and when the app comes back; here, every minute and on focus.
  const qr = useQuery({ queryKey: storeKey(storeId, 'qr'), queryFn: getQr, enabled: manager, refetchInterval: 60_000 });
  const shortCode = qr.data?.shortCode ?? null;
  const publicCheck = useQuery({
    queryKey: storeKey(storeId, 'qr-public', shortCode ?? ''),
    queryFn: () => getQrPublicState(shortCode!),
    enabled: manager && !!shortCode,
    refetchInterval: 60_000,
  });
  const [canShare, setCanShare] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'); }, []);
  useEffect(() => { setNotice(null); }, [storeId]);

  const data = qr.data;
  const complete = !!(data?.shortCode && data.shortUrl && data.svg);
  const publicState: PublicState = publicCheck.data
    ? (publicCheck.data.verdict === 'WEB_RENDER' && !!storeId && publicCheck.data.vendorId === storeId ? 'live' : 'unavailable')
    : publicCheck.isError ? 'error' : 'checking';
  const live = publicState === 'live';
  const vendorName = data?.vendorName ?? '';
  const shortUrl = data?.shortUrl ?? '';
  const message = `Order from ${vendorName} on Swift: ${shortUrl}`;

  const copyLink = async () => {
    if (!live) return;
    try {
      await navigator.clipboard.writeText(shortUrl);
      setNotice('Store link copied.');
    } catch {
      setNotice("Couldn't copy the link. Use Share link instead.");
    }
  };
  const shareLink = async () => {
    if (!live) return;
    try {
      await navigator.share({ text: message });
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice("Couldn't open the share sheet.");
    }
  };
  const checkAgain = () => {
    setNotice(null);
    void qr.refetch();
    if (shortCode) void publicCheck.refetch();
  };

  const disabledLook = 'disabled:cursor-not-allowed disabled:opacity-55';

  return (
    <div className="space-y-6">
      <h1 className="sw-title">My QR &amp; number</h1>

      {known && !manager && <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">The store link is shared by the store’s owner and managers.</p>}

      {manager && qr.isLoading && <div role="status" className="sw-skeleton h-72"><span className="sr-only">Loading your store’s QR code…</span></div>}

      {manager && !qr.isLoading && (!data || !complete) && (
        <div role="status" className="sw-card flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-[var(--swift-muted)]">We couldn&apos;t load this store&apos;s QR code. Check your connection and try again.</p>
          <button type="button" onClick={() => void qr.refetch()} className="sw-btn sw-btn-md">Try again</button>
        </div>
      )}

      {manager && data && complete && (
        <>
          <div className="grid gap-6 wide:grid-cols-2">
            <section aria-label="Your store QR code" data-testid="store-qr" className="sw-card flex flex-col items-center p-6 text-center">
              {/* The server's code, drawn as an image: never written into the page as markup. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/svg+xml,${encodeURIComponent(data.svg!)}`}
                alt={`QR code for ${vendorName}`}
                width={240}
                height={240}
                className={`h-60 w-60 rounded-xl bg-white p-4 ${live ? '' : 'opacity-55'}`}
              />
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <p className="font-bold">{vendorName}</p>
                <span className="whitespace-nowrap rounded-full bg-[var(--swift-sunken)] px-3 py-1 text-[12px] font-semibold text-[var(--swift-muted)]">v{data.version}</span>
              </div>
              <p className={`mt-1 text-[13px] ${live ? 'text-[var(--swift-muted)]' : 'text-[var(--swift-warning)]'}`}>{STATE_WORDS[publicState]}</p>
              <button
                type="button"
                onClick={() => void copyLink()}
                disabled={!live}
                aria-label="Copy web store link"
                title="Copies the short link customers can use to order"
                className={`mt-4 inline-flex min-h-11 max-w-full items-center gap-2 rounded-full bg-[var(--swift-sunken)] px-4 text-[14px] font-semibold text-[var(--swift-red)] hover:outline hover:outline-1 hover:outline-[var(--swift-border-strong)] ${disabledLook}`}
              >
                <span className="min-w-0 break-all">{shortUrl}</span>
                <Copy size={16} aria-hidden="true" className="shrink-0" />
              </button>
              <p role="status" aria-live="polite" className="mt-2 min-h-5 text-[13px] text-[var(--swift-muted)]">{notice}</p>
            </section>

            <div className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                {canShare ? (
                  <button type="button" onClick={() => void shareLink()} disabled={!live} className={`sw-btn sw-btn-md flex-1 ${disabledLook}`}>
                    <Share2 size={16} aria-hidden="true" />Share link
                  </button>
                ) : live ? (
                  <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-md flex-1">
                    <Share2 size={16} aria-hidden="true" />Share on WhatsApp
                  </a>
                ) : (
                  <button type="button" disabled className={`sw-btn sw-btn-md flex-1 ${disabledLook}`}>
                    <Share2 size={16} aria-hidden="true" />Share link
                  </button>
                )}
                {live ? (
                  <a href={data.canonicalUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-md sw-btn-outline flex-1">
                    <ExternalLink size={16} aria-hidden="true" />Open web menu
                  </a>
                ) : (
                  <button type="button" disabled className={`sw-btn sw-btn-md sw-btn-outline flex-1 ${disabledLook}`}>
                    <ExternalLink size={16} aria-hidden="true" />Open web menu
                  </button>
                )}
              </div>

              {live ? (
                <HowItWorks />
              ) : (
                <section aria-label="Store link not ready" className="sw-card p-5">
                  <p className="font-semibold">Store link not ready</p>
                  <p className="sw-caption mt-1">Swift only enables sharing after the public resolver confirms this exact store. Check your store approval and availability, then retry.</p>
                  <button type="button" onClick={checkAgain} className="sw-btn sw-btn-md sw-btn-outline mt-3 w-full">Check again</button>
                </section>
              )}

              <section aria-label="Your Swift call-in number" className="sw-card p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <PhoneOff size={18} aria-hidden="true" className="text-[var(--swift-muted)]" />
                  <p className="flex-1 font-semibold">Your Swift call-in number</p>
                  <span className="whitespace-nowrap rounded-full bg-[var(--swift-sunken)] px-3 py-1 text-[12px] font-semibold text-[var(--swift-muted)]">Not assigned</span>
                </div>
                <p className="sw-caption mt-2">Swift does not yet issue a call-in order number for this store. Online orders still land in Orders with every other live order.</p>
              </section>

              <section aria-label="Where to place your QR" className="sw-card p-5">
                <p className="font-semibold">Where to place your QR</p>
                <ul className="mt-3 space-y-2">
                  {TIPS.map((tip) => (
                    <li key={tip} className="flex items-center gap-3"><Check size={14} aria-hidden="true" className="text-[var(--swift-red)]" /><span className="sw-caption">{tip}</span></li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
