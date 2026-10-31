'use client';

import { useWebOrderingOpen, useWebOrderingSoon } from '@/lib/use-web-ordering';
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

/** [OPEN-EARLY] Before launch: documents are checked as they arrive; approval comes on launch day. */
export const PRELAUNCH_REVIEW = 'We check documents as they arrive and approve partners on launch day.';
/** True before and after launch, for the moment the server's answer is not known. */
export const REVIEW_NEUTRAL = 'A person checks your documents before you go live.';

/**
 * [OPEN-EARLY · owner 31 Oct 2026] A partner page's review-time sentence, which is true only once Swift is open
 * (how soon most partners clear review). The same server answer as the note decides: "soon" says launch day,
 * open (live on the public site, or staging and local runs) says `live`, and while the answer is on its way or if it
 * failed, a sentence true in both states. `after` (optional) follows in the soon and unknown states.
 */
export function ReviewTime({ live, after }: { live: string; after?: string }) {
  const soon = useWebOrderingSoon();
  const open = useWebOrderingOpen();
  const lead = soon ? PRELAUNCH_REVIEW : REVIEW_NEUTRAL;
  return <>{open ? live : after ? `${lead} ${after}` : lead}</>;
}
