'use client';

import { useEffect, useRef } from 'react';
import { CARD_FRAME_SANDBOX } from '@/lib/card-frame';

/** How often the open card page asks the server whether the card session is still open. */
export const CARD_FRAME_WATCH_MS = 4_000;

/**
 * The bank's card page INSIDE the weekly-fee page: Swift's own API card page in a sandboxed
 * frame. The card is typed only in the bank's form, inside it; this page has no field and
 * listens to nothing the frame says (no message handler): a frame can claim anything.
 * It closes on Close (or Escape) and when the server says the card page is no longer open.
 * Closing decides nothing: the card section then asks the server what happened.
 */
export default function CardPageFrame({ src, watch, onDone }: {
  src: string;
  /** The server's read: true while the card session is still open. */
  watch?: () => Promise<boolean>;
  onDone: () => void;
}) {
  const done = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const close = useRef<HTMLButtonElement>(null);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    doneRef.current();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    if (!watch) return undefined;
    let stopped = false;
    const timer = setInterval(() => {
      watch().then((open) => { if (!stopped && !open) finishRef.current(); }, () => { /* Unreadable: the page stays; Close is always there. */ });
    }, CARD_FRAME_WATCH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [watch]);

  return <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="card-frame-title"
    onKeyDown={(event) => { if (event.key === 'Escape') finishRef.current(); }}
    className="fixed inset-0 z-50 flex flex-col bg-white"
  >
    <div className="flex items-center gap-3 border-b border-black/5 px-4 py-3 sm:px-6">
      <div className="min-w-0 flex-1">
        <h2 id="card-frame-title" className="text-base font-bold">Secure card page</h2>
        <p className="text-sm text-[var(--swift-muted)]">Your bank&apos;s form. Swift never sees your card number.</p>
      </div>
      <button ref={close} type="button" onClick={() => finishRef.current()} className="min-h-11 rounded-full border border-black/10 bg-white px-4 text-sm font-semibold">Close</button>
    </div>
    <iframe
      src={src}
      title="Your bank's secure card page"
      sandbox={CARD_FRAME_SANDBOX}
      allow="payment"
      referrerPolicy="no-referrer"
      className="w-full flex-1 border-0"
    />
  </div>;
}
