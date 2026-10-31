'use client';

import { useWebOrderingSoon } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';

/** [OPEN-EARLY · owner 31 Oct 2026] The words, once: true as written while the public site is not open yet. */
export function prelaunchPartnerWords(): string {
  return `Swift opens in ${launchCity()} soon. We check documents now and approve partners on launch day. Your free trial starts the day you are approved.`;
}

/**
 * [OPEN-EARLY · owner 31 Oct 2026: "review now, approve on launch day"] Partners can sign up and send their
 * documents before launch; a person checks them now and approves them on launch day, when each free trial starts.
 * Shown on the public site only, and only once the server has said ordering is not open yet
 * (lib/use-web-ordering.ts useWebOrderingSoon): never on a guess, never after launch, never on staging.
 */
export function PrelaunchPartnerNote({ className = '' }: { className?: string }) {
  const soon = useWebOrderingSoon();
  if (!soon) return null;
  return (
    <p data-prelaunch-partner-note role="note" className={`rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-subtle)] p-4 text-sm leading-relaxed text-[var(--swift-ink)] ${className}`}>
      {prelaunchPartnerWords()}
    </p>
  );
}
