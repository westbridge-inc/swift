'use client';

/**
 * [PERF · 6 Nov 2026] The Orders home's two first-steps cards: the first-order guide and the not-live guide.
 * They show only while a store has no order yet, so they ship in their own chunk, off the Orders page's first load
 * (perf budget). Same words and reads as before (orders-home.tsx, copied from the phone app's business board).
 */
import Link from 'next/link';
import { Check, ChevronRight } from 'lucide-react';
import { catalogueName } from '@/lib/catalogue-name';
import { ownerSteps } from '@/lib/branch-go-live';
import { waitingFor } from '@/lib/branch-label';
import { NOT_LIVE } from '@/lib/first-steps';
import { useItems, useQr, type HubStore } from './orders-home';

function GuideRow({ index, label, detail, done, href }: { index: number; label: string; detail: string; done?: boolean; href?: string }) {
  const body = (
    <>
      <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-white/15 text-[12px] font-semibold">{done ? <Check size={14} aria-hidden="true" /> : index}</span>
      <span className="min-w-0 flex-1"><span className="block font-semibold">{label}</span><span className="block truncate text-[13px] opacity-90">{detail}</span></span>
      {href && <ChevronRight size={16} aria-hidden="true" />}
    </>
  );
  const cls = 'flex min-h-11 items-center gap-3 rounded-xl bg-white/10 px-3 py-2';
  if (!href) return <div className={cls}>{body}</div>;
  return <Link href={href} className={`${cls} hover:bg-white/15`}>{body}</Link>;
}

/** VendorBoardEmpty's first-morning card: "The board is live." with three real next steps. */
export function FirstOrderGuide({ store, manager, listening }: { store: HubStore; manager: boolean; listening: boolean }) {
  const itemsQ = useItems();
  const qrQ = useQr(manager);
  const catalogue = catalogueName(store.vendorType).toLowerCase();
  const items = itemsQ.data ?? [];
  const missingPhotos = items.filter((i) => !i.imageUrl).length;
  const shortUrl = qrQ.data?.shortUrl ?? undefined;
  const open = !!store.isCurrentlyOpen;
  return (
    <section aria-label="Your first order" className="rounded-2xl bg-[var(--swift-red-600)] p-6 text-white">
      <p className="text-[11px] font-bold tracking-[0.1em] opacity-80">YOUR FIRST ORDER</p>
      <p className="mt-1 text-[24px] font-semibold leading-8 [font-family:var(--swift-face-display)]">The board is live.</p>
      <p className="mt-2 opacity-90">Orders land here the second they&apos;re placed, with a sound you can&apos;t miss. These bring the first one sooner:</p>
      <div className="mt-4 space-y-2">
        {manager && !itemsQ.isSuccess ? (
          <GuideRow index={1} label={itemsQ.isError ? 'Menu status unavailable' : 'Checking your menu'} detail={itemsQ.isError ? 'Open the menu to check its items' : 'Loading your menu details'} href="/dashboard/inventory" />
        ) : manager && items.length === 0 ? (
          <GuideRow index={1} label="Add your first item" detail={`Your ${catalogue} is empty — nothing to order yet`} href="/dashboard/inventory" />
        ) : manager ? (
          <GuideRow index={1} label={`Add photos to your ${catalogue}`} done={missingPhotos === 0}
            detail={missingPhotos === 0 ? `All ${items.length} items have a photo` : `Photos missing on ${missingPhotos} of ${items.length} items`} href="/dashboard/inventory" />
        ) : null}
        <GuideRow index={manager ? 2 : 1} label={open ? 'You are open' : 'Your store is closed'} done={open}
          detail={open ? 'Customers can order right now' : manager ? 'Use the switch below to start taking orders' : 'Ask a manager or owner to open the store'} />
        {/* [STORE-LINK] As the phone (VendorOps opens VendorMyQr): the store's QR page, where the link is copied and shared. */}
        {manager && <GuideRow index={3} label="Share your store link" detail={shortUrl ?? (qrQ.isError ? 'Link unavailable — try again shortly' : 'Loading your live store link')} href="/dashboard/qr" />}
      </div>
      <p className="mt-4 flex items-center gap-2 text-[11px] font-bold tracking-[0.1em]">
        <span className={`h-2 w-2 rounded-full ${listening ? 'bg-[var(--swift-success)]' : 'bg-white/40'}`} aria-hidden="true" />
        {listening ? 'LISTENING FOR ORDERS' : 'RECONNECTING TO THE BOARD'}
      </p>
    </section>
  );
}

/**
 * [WEB-ONBOARDING · owner 1 Nov 2026] A store not live yet (never approved): in place of the first-order guide, what is
 * left and whose turn it is, as the app's waiting store screen (VendorOnboarding) says it. The owner's steps are the
 * server's (`goLive`), each opening where it is done on this website. A menu comes after approval: the API refuses items before it
 * (FULL-LAUNCH 5 Nov 2026), so an empty menu is said here, with no door to it.
 */
export function NotLiveGuide({ store, manager, owner }: { store: HubStore; manager: boolean; owner: boolean }) {
  const itemsQ = useItems();
  const catalogue = catalogueName(store.vendorType).toLowerCase();
  const swiftsTurn = waitingFor(store) === 'SWIFT';
  const steps = owner && !swiftsTurn ? ownerSteps(store) : [];
  const body = swiftsTurn ? NOT_LIVE.swiftBody : !owner ? NOT_LIVE.staffBody : steps.length > 0 ? NOT_LIVE.ownerBody : NOT_LIVE.noWord;
  const emptyCatalogue = manager && itemsQ.isSuccess && (itemsQ.data ?? []).length === 0;
  return (
    <section aria-label="Your store is not live yet" className="rounded-2xl bg-[var(--swift-red-600)] p-6 text-white">
      <p className="text-[11px] font-bold tracking-[0.1em] opacity-80">{NOT_LIVE.kicker}</p>
      <p className="mt-1 text-[24px] font-semibold leading-8 [font-family:var(--swift-face-display)]">{swiftsTurn ? NOT_LIVE.swiftTurn : NOT_LIVE.ownerTurn}</p>
      <p className="mt-2 opacity-90">{body}</p>
      {(steps.length > 0 || emptyCatalogue) && (
        <div className="mt-4 space-y-2">
          {steps.map((step, i) => (
            <GuideRow key={step.words} index={i + 1} label={step.words} href={step.where === 'documents' ? '/dashboard/documents' : '/dashboard/settings'}
              detail={step.where === 'documents' ? 'A person at Swift checks each one' : 'In your store’s Settings'} />
          ))}
          {emptyCatalogue && <GuideRow index={steps.length + 1} label={`Add your ${catalogue} once you’re approved`} detail="You can add items then" />}
        </div>
      )}
      <p className="mt-4 text-sm opacity-90">{NOT_LIVE.wait}</p>
    </section>
  );
}
