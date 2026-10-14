'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Share, X } from 'lucide-react';

/**
 * [PWA-1] The install card as the visitor sees it, loaded only once an offer
 * is possible on Home (install-prompt.tsx `loadInstallCard`). What it offers,
 * when, and what Install and Dismiss do, all come from the prompt.
 */
export function InstallCard({ offer, onInstall, onDismiss }: { offer: 'install' | 'ios-hint'; onInstall: () => void; onDismiss: () => void }) {
  const card = useRef<HTMLElement | null>(null);
  const [clearance, setClearance] = useState(0);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    // Include wrapped Safari steps and the padding above the dock/home bar.
    const measure = () => setClearance(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element, { box: 'border-box' });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [offer]);

  return (
    <>
    <div aria-hidden="true" data-install-clearance style={{ height: clearance }} />
    <aside ref={card} aria-label="Install Swift" className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(1rem_+_var(--swift-dock,env(safe-area-inset-bottom)))]">
      <div className="mx-auto max-w-md sw-card p-3 shadow-[var(--swift-elevation-floating)]">
        <div className="flex items-center gap-3">
          <Image src="/icons/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Install Swift</p>
            <p className="text-xs text-[var(--swift-muted)]">Open Swift from your home screen.</p>
          </div>
          {offer === 'install' && <button type="button" onClick={onInstall} className="sw-btn sw-btn-sm">Install</button>}
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)]"><X className="h-4 w-4" aria-hidden /></button>
        </div>
        {offer === 'ios-hint' && (
          <ol className="mt-3 list-inside list-decimal space-y-2 border-t border-[var(--swift-border)] pt-3 text-sm">
            <li>Tap <Share aria-hidden className="inline h-4 w-4 align-[-2px]" /> <b>Share</b> in Safari.</li>
            <li>Scroll down and choose <b>Add to Home Screen</b>.</li>
            <li>Tap <b>Add</b>, then open the Swift icon.</li>
          </ol>
        )}
      </div>
    </aside>
    </>
  );
}
