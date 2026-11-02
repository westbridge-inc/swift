'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/auth';
import { isStepUpDismissed, useStepUp } from '@/lib/step-up';
import { DataUnavailable } from '@/components/data-unavailable';
import {
  DELETED_PAGE, cancelAccountClosure, deleteMyAccount, getDeletionCheck, requestAccountClosure, stashDeletionReceipt,
  type DeletionCheck, type DeletionSide,
} from '@/lib/account-deletion';
import {
  CLOSURE_IN_HAND, CLOSURE_LEAD, DELETE_LEAD, DELETION_GONE, DELETION_KEPT, DELETION_KEPT_LEAD, MOVER_DELETION_EFFECTS, STAFF_DELETION_EFFECTS,
  STORE_CLOSURE_LATER, STORE_CLOSURE_NOW, STORE_ORDERS_PAUSED, STORE_ORDERS_PAUSE_NOW,
} from '@/lib/account-deletion-words';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] "Delete my account" on the website, as the phone does it
// (apps/mobile PersonalDataScreen: Profile -> Personal data -> Delete my account): the server says whether this
// account deletes or closes by a request the team completes (a store owner), the phone's words and buttons,
// "Confirm it's you" when the server asks for a fresh code, then the person is signed out everywhere and lands
// on the deleted page. Before the code is asked for, the server's deletion check names WHICH live orders, jobs
// and money stop the delete, by the deletion's own rules. Every refusal is the server's sentence.
// ---------------------------------------------------------------------------

export type DeletionArea = 'store' | 'mover' | 'customer';

/** "PICKED_UP" -> "Picked up": any status the server sends is shown, never hidden. */
const statusWords = (status: string) => (status.charAt(0) + status.slice(1).toLowerCase()).replace(/_/g, ' ');

function orderLine(side: DeletionSide, storeName: string | null): string {
  if (side === 'CUSTOMER') return storeName ? `your order from ${storeName}` : 'your order';
  if (side === 'RIDER') return 'a delivery assigned to you';
  if (side === 'DRIVER') return 'a trip assigned to you';
  return storeName ? `an order at your store ${storeName}` : 'an order at your store';
}

function errorWords(e: unknown): string | null {
  if (!e || isStepUpDismissed(e)) return null;
  if (e instanceof ApiRequestError) return e.message;
  return 'Swift can’t be reached right now. Check your connection and try again.';
}

/** The refusals the deletion check explains: read it again so the list on screen is the one the server refused on. */
const RECHECK_CODES = new Set(['ACTIVE_ORDERS', 'ACTIVE_SERVICE_JOBS', 'PARTNER_OBLIGATIONS']);

export function DeleteAccountFlow({ area, backHref }: { area: DeletionArea; backHref: string }) {
  const check = useQuery({ queryKey: ['account', 'deletion-check'], queryFn: getDeletionCheck, retry: false, staleTime: 0, gcTime: 0 });
  if (check.isError) {
    return <Frame title="Your Swift account"><DataUnavailable what="what your account still has open" error={check.error} onRetry={() => void check.refetch()} /></Frame>;
  }
  // Delete or closure request is the server's answer: the title waits for it.
  if (!check.data) return <Frame title="Your Swift account"><p role="status" className="text-sm text-[var(--swift-muted)]">Checking your account…</p></Frame>;
  return <Flow area={area} backHref={backHref} check={check.data} recheck={() => void check.refetch()} rechecking={check.isFetching} />;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-5">
      <div><span className="sw-eyebrow">Account</span><h1 className="sw-title mt-1">{title}</h1></div>
      {children}
    </div>
  );
}

function Flow({ area, backHref, check, recheck, rechecking }: {
  area: DeletionArea; backHref: string; check: DeletionCheck; recheck: () => void; rechecking: boolean;
}) {
  const closure = check.closure === 'REQUEST';
  const stepUp = useStepUp();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // [owner ruling 1 Nov 2026] The server's words once the owner cancels their request.
  const [notice, setNotice] = useState<string | null>(null);
  const sending = useRef(false);

  const live = check.openOrders.count + check.openServiceJobs.count;
  // A deletion waits for live work and money; a closure request goes in now and the team finishes it after.
  const blocked = !closure && (live > 0 || check.settleFirst !== null);
  const title = closure ? 'Request account closure' : 'Delete my account';

  const run = async () => {
    if (sending.current || !ticked || blocked) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await stepUp.withStepUp(closure ? requestAccountClosure : deleteMyAccount)();
      if (receipt.status === 'CLOSURE_REQUESTED') {
        // A request, not a deletion: the person stays signed in and sees it on this page.
        setNotice(null);
        setSent(true);
        recheck();
        sending.current = false;
        setBusy(false);
        return;
      }
      // Closed (deleted, or closed with erasure still finishing): every session is gone on the server. The deleted
      // page expires this browser's cookies once the server confirms that, and says what was done. The button
      // stays disabled while the page leaves, so nothing is sent twice.
      stashDeletionReceipt(receipt);
      window.location.replace(`${DELETED_PAGE}?status=${encodeURIComponent(receipt.status ?? 'DELETED')}`);
    } catch (e) {
      setError(errorWords(e));
      if (e instanceof ApiRequestError && RECHECK_CODES.has(e.code ?? '')) recheck();
      sending.current = false;
      setBusy(false);
    }
  };

  // [owner ruling 1 Nov 2026] Cancelling takes the request back: it is resolved and its pause on new orders lifted.
  const cancel = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const done = await stepUp.withStepUp(cancelAccountClosure)();
      setNotice(done.message);
      setSent(false);
      setTicked(false);
      recheck();
    } catch (e) {
      setError(errorWords(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (closure && (check.closureRequest || sent)) {
    const when = new Date(check.closureRequest?.requestedAt ?? Date.now());
    // A request just sent holds the pause; an older one says what the server reads.
    const paused = check.ownsStore && (check.closureRequest ? check.closureRequest.ordersPaused : sent);
    return (
      <Frame title="Your closure request is with our team">
        <div role="status" className="sw-card space-y-2 p-5 text-sm">
          <p className="font-semibold">We received your request{Number.isNaN(when.getTime()) ? '' : ` on ${when.toLocaleDateString('en-GY', { day: 'numeric', month: 'long', year: 'numeric' })}`}.</p>
          <p className="text-[var(--swift-muted)]">You keep access while our team resolves listings and anything outstanding. Nothing else is needed from you now; you don&apos;t need to send it again.</p>
          {paused && <p className="font-semibold">{STORE_ORDERS_PAUSED}</p>}
        </div>
        {/* [REVIEW-F #2304 S4-1] Once Swift's team has the request (IN_PROGRESS) the server refuses a cancel: no button. */}
        {check.closureRequest?.status === 'IN_PROGRESS' ? (
          <p className="sw-card p-5 text-sm">{CLOSURE_IN_HAND} <Link href="/contact" className="font-semibold underline">Contact Swift support</Link>.</p>
        ) : (
          <div className="sw-card space-y-3 p-5 text-sm">
            <p className="text-[var(--swift-muted)]">Changed your mind? Cancel the request{check.ownsStore ? ': your weekly fee starts again from then, and your store can take new orders again once you resume them' : ''}.</p>
            {error && <p role="alert" className="font-semibold text-[var(--swift-red)]">{error}</p>}
            <button type="button" className="sw-btn sw-btn-md sw-btn-outline" disabled={busy || !check.closureRequest} onClick={() => void cancel()}>
              {busy ? 'Cancelling…' : 'Cancel my closure request'}
            </button>
          </div>
        )}
        <LiveWork check={check} closure recheck={recheck} rechecking={rechecking} />
        <Effects area={area} closure ownsStore={check.ownsStore} />
        <Gone />
        <Kept />
        <Footer backHref={backHref} />
        {stepUp.dialog}
      </Frame>
    );
  }

  return (
    <Frame title={title}>
      {notice && <p role="status" className="rounded-2xl bg-[var(--swift-subtle)] p-4 text-sm font-semibold">{notice}</p>}
      <p className="text-[15px] leading-6 text-[var(--swift-muted)]">{closure ? CLOSURE_LEAD : DELETE_LEAD}</p>
      <LiveWork check={check} closure={closure} recheck={recheck} rechecking={rechecking} />
      <Effects area={area} closure={closure} ownsStore={check.ownsStore} />
      {closure && check.ownsStore && <p className="rounded-2xl bg-[var(--swift-subtle)] p-4 text-sm font-semibold">{STORE_ORDERS_PAUSE_NOW}</p>}
      <Gone />
      <Kept />

      <section aria-label="Confirm" className="sw-card space-y-4 p-5">
        <label className="flex min-h-11 items-start gap-3 text-sm font-semibold">
          <input type="checkbox" checked={ticked} disabled={busy || blocked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5 h-5 w-5 flex-none accent-[var(--swift-red)]" />
          <span>{!closure ? 'I understand that deleting my account cannot be undone.'
            : check.ownsStore ? 'I want Swift to close my account. I understand my store stops taking new orders, and my weekly fee stops, now.' : 'I want Swift to close my account.'}</span>
        </label>
        {error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
        {error && <p className="text-sm text-[var(--swift-muted)]">Need a hand? <Link href="/contact" className="font-semibold underline">Contact Swift support</Link>.</p>}
        <div className="flex flex-col gap-3 sm:flex-row">
          {/* [#947's grammar] A disabled button says what it is waiting for. */}
          <button type="button" className="sw-btn sw-btn-md bg-[var(--swift-red)] text-white" disabled={busy || blocked || !ticked} onClick={() => void run()}>
            {busy ? (closure ? 'Sending your request…' : 'Deleting your account…')
              : blocked ? 'Finish or settle the things above first'
                : !ticked ? 'Tick the box to continue' : title}
          </button>
          <Link href={backHref} className="sw-btn sw-btn-md sw-btn-outline">Keep my account</Link>
        </div>
        <p className="text-xs text-[var(--swift-muted)]">
          {closure ? 'We may text a code to the phone on this account to confirm it’s you.' : 'We may text a code to the phone on this account to confirm it’s you. Once your account is deleted, this browser and every other device are signed out.'}
        </p>
      </section>
      <Footer backHref={backHref} />
      {stepUp.dialog}
    </Frame>
  );
}

function LiveWork({ check, closure, recheck, rechecking }: { check: DeletionCheck; closure: boolean; recheck: () => void; rechecking: boolean }) {
  const { openOrders, openServiceJobs, settleFirst } = check;
  if (openOrders.count === 0 && openServiceJobs.count === 0 && !settleFirst) return null;
  const more = openOrders.count - openOrders.items.length + openServiceJobs.count - openServiceJobs.items.length;
  return (
    <section aria-label={closure ? 'Before our team can close your account' : 'Finish these first'} className="rounded-2xl border border-[var(--swift-red)] p-5 text-sm">
      <h2 className="font-bold">{closure ? 'Before our team can close your account' : 'Finish these first'}</h2>
      {(openOrders.count > 0 || openServiceJobs.count > 0) && (
        <>
          <p className="mt-1 text-[var(--swift-muted)]">
            {closure
              ? 'These are still open. Our team closes your account once each one is delivered, finished or cancelled.'
              : 'Finish or cancel these before you delete your account. For a job already collected, finish the handover, or contact Swift support to resolve it.'}
          </p>
          <ul className="mt-3 space-y-2">
            {openOrders.items.map((o) => (
              <li key={o.id} className="rounded-lg bg-[var(--swift-subtle)] px-3 py-2">
                <span className="font-semibold">#{o.orderNumber}</span> · {statusWords(o.status)} · {orderLine(o.side, o.storeName)}
              </li>
            ))}
            {openServiceJobs.items.map((j) => (
              <li key={j.id} className="rounded-lg bg-[var(--swift-subtle)] px-3 py-2">
                <span className="font-semibold">Service job</span> · {statusWords(j.status)} · {j.side === 'CUSTOMER' ? 'a service you booked' : 'a job you are booked for'}
              </li>
            ))}
          </ul>
          {more > 0 && <p className="mt-2 text-[var(--swift-muted)]">And {more} more.</p>}
        </>
      )}
      {settleFirst && <p className="mt-3 font-semibold">{settleFirst.message}</p>}
      <button type="button" className="sw-chip mt-3" disabled={rechecking} onClick={recheck}>{rechecking ? 'Checking…' : 'Check again'}</button>
    </section>
  );
}

function Effects({ area, closure, ownsStore }: { area: DeletionArea; closure: boolean; ownsStore: boolean }) {
  if (closure && ownsStore) {
    // [REVIEW-F #2304 S3-3] What happens now, and what happens when Swift's team closes the account, apart.
    return (
      <section aria-label="What happens to your store" className="sw-card p-5 text-sm">
        <h2 className="font-bold">What happens to your store</h2>
        <h3 className="mt-2 font-semibold">Now, when you send the request</h3>
        <ul aria-label="Now" className="mt-1 list-disc space-y-1.5 pl-5 text-[var(--swift-muted)]">{STORE_CLOSURE_NOW.map((line) => <li key={line}>{line}</li>)}</ul>
        <h3 className="mt-3 font-semibold">When Swift closes your account</h3>
        <ul aria-label="When Swift closes your account" className="mt-1 list-disc space-y-1.5 pl-5 text-[var(--swift-muted)]">{STORE_CLOSURE_LATER.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
    );
  }
  const lines = closure ? null
    : area === 'store' ? STAFF_DELETION_EFFECTS : area === 'mover' ? MOVER_DELETION_EFFECTS : null;
  if (!lines) return null;
  const heading = closure ? 'What happens to your store' : area === 'store' ? 'Your store team' : 'Your rider or driver account';
  return (
    <section aria-label={heading} className="sw-card p-5 text-sm">
      <h2 className="font-bold">{heading}</h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[var(--swift-muted)]">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </section>
  );
}

function Gone() {
  return (
    <section aria-label="What is deleted" className="sw-card p-5 text-sm">
      <h2 className="font-bold">What is deleted</h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[var(--swift-muted)]">{DELETION_GONE.map((line) => <li key={line}>{line}</li>)}</ul>
    </section>
  );
}

function Kept() {
  return (
    <section aria-label="What Swift keeps, and for how long" className="sw-card p-5 text-sm">
      <h2 className="font-bold">What Swift keeps, and for how long</h2>
      <p className="mt-1 text-[var(--swift-muted)]">{DELETION_KEPT_LEAD}</p>
      <dl className="mt-3 space-y-3">
        {DELETION_KEPT.map((row) => (
          <div key={row.what}>
            <dt className="font-semibold">{row.what}</dt>
            <dd className="mt-0.5 text-[var(--swift-muted)]">{row.why} {row.howLong}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Footer({ backHref }: { backHref: string }) {
  return (
    <p className="text-sm text-[var(--swift-muted)]">
      <Link href={backHref} className="underline">Back to your account</Link>
      {' · '}<Link href="/account/delete" className="underline">How account deletion works</Link>
      {' · '}<Link href="/legal/privacy" className="underline">Privacy policy</Link>
    </p>
  );
}
