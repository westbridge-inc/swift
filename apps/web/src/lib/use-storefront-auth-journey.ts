'use client';

import { useEffect, useRef } from 'react';
import { clearStorefrontContinuation } from './storefront-continuation';

/** Preserve only explicit auth handoffs and successful returns to the menu. */
export function useStorefrontAuthJourney() {
  const continuing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const cancel = () => { continuing.current = false; clearStorefrontContinuation(); };
    window.addEventListener('popstate', cancel);
    window.addEventListener('pagehide', cancel);
    return () => {
      mounted.current = false;
      window.removeEventListener('popstate', cancel);
      window.removeEventListener('pagehide', cancel);
      // Strict Mode rehearses effects without leaving the page.
      queueMicrotask(() => {
        if (!mounted.current && !continuing.current) clearStorefrontContinuation();
      });
    };
  }, []);
  return () => { continuing.current = true; };
}
