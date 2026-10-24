'use client';

import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';

/**
 * [Item 7] A page's one sentence about ordering in the browser, true on every
 * host: where ordering is open it says so (in the page's own words); on the
 * public site before launch it says when instead. Text only — the caller's
 * paragraph holds it, beside the taxi sentence that stays the same.
 */
export function BrowserOrderingNote({ open: openText = 'Store ordering works in your browser.' }: { open?: string }) {
  const open = useWebOrderingOpen();
  return <>{open ? openText : `Ordering opens soon in ${launchCity()}.`}</>;
}
