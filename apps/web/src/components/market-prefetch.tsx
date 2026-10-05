'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { marketItemsQuery, mayPrefetch } from '@/lib/market-queries';
import { marketTabVisible } from '@/lib/app-rules';

/** Delegated to the existing chips so parity owns their presentation. */
export function MarketPrefetch({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const categoryLink = (event: Event) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || !element.contains(link)) return null;
      const url = new URL(link.href, window.location.href);
      return url.origin === window.location.origin && url.pathname === '/market' ? url : null;
    };
    const prefetch = (event: Event) => {
      const url = categoryLink(event);
      if (url?.search === window.location.search) return;
      if (url && mayPrefetch() && marketTabVisible(client.getQueryData(['market', 'depth']))) {
        void client.prefetchInfiniteQuery(marketItemsQuery(url.searchParams.get('category') ?? ''));
      }
    };
    const navigate = (event: MouseEvent) => {
      const url = categoryLink(event);
      if (!url || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // Next observes native history updates. Keep open-in-new-tab behavior,
      // but consume the warmed query without a new server component request.
      event.preventDefault();
      event.stopPropagation();
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    };
    element.addEventListener('mouseover', prefetch);
    element.addEventListener('focusin', prefetch);
    element.addEventListener('click', navigate, true);
    return () => {
      element.removeEventListener('mouseover', prefetch);
      element.removeEventListener('focusin', prefetch);
      element.removeEventListener('click', navigate, true);
    };
  }, [client]);
  return <div ref={root}>{children}</div>;
}
