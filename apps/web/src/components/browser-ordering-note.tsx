'use client';

import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';

/**
 * [Item 7] The footer's one sentence about ordering in the browser, true on
 * every host: where ordering is open it says so; on the public site before
 * launch it says when instead. Text only — the footer's own paragraph holds it.
 */
export function BrowserOrderingNote() {
  const open = useWebOrderingOpen();
  return <>{open ? 'Store ordering works in your browser.' : `Ordering opens soon in ${launchCity()}.`}</>;
}
