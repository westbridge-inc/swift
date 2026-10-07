'use client';

import { RefreshCcw } from 'lucide-react';

/** Route-segment error boundary — without this file a thrown render/data error
 *  surfaces as Next's unstyled crash screen. Recovery first: `reset()` re-renders
 *  the segment, so a transient API blip doesn't strand the visitor. */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="font-display text-[56px] font-bold leading-none text-[var(--swift-red)]">Oops</p>
      <h1 className="sw-title mt-3">Something went wrong on this page</h1>
      <p className="mt-2 max-w-md text-sm text-[var(--swift-muted)]">
        It&apos;s not you — a hiccup on our side. Trying again usually fixes it.
      </p>
      <button
        onClick={reset}
        className="mt-6 inline-flex items-center gap-2 sw-btn sw-btn-md"
      >
        <RefreshCcw className="h-4 w-4" aria-hidden />
        Try again
      </button>
      {/* Hard navigation is deliberate: after a render error, a full document
          load to "/" gives a clean React tree — a client-side <Link> would reuse
          the faulted router state and can re-throw. Intentional, not a miss. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="mt-4 text-sm font-medium text-[var(--swift-muted)] transition-colors hover:text-[var(--swift-ink)]">
        Back to home
      </a>
    </main>
  );
}
