'use client';

import { RefreshCcw } from 'lucide-react';

/** Route-segment error boundary — without this file a thrown render/data error
 *  surfaces as Next's unstyled crash screen. Recovery first: `reset()` re-renders
 *  the segment, so a transient API blip doesn't strand the visitor. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl font-black text-[var(--swift-red)]">Oops</p>
      <h1 className="mt-3 text-xl font-bold text-[var(--swift-ink)]">Something went wrong on this page</h1>
      <p className="mt-2 max-w-md text-sm text-[var(--swift-muted)]">
        It&apos;s not you — a hiccup on our side. Trying again usually fixes it.
        {error.digest ? ` (ref ${error.digest})` : null}
      </p>
      <button
        onClick={reset}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--swift-red)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
      >
        <RefreshCcw className="h-4 w-4" aria-hidden />
        Try again
      </button>
      <a href="/" className="mt-4 text-sm font-medium text-[var(--swift-muted)] transition-colors hover:text-[var(--swift-ink)]">
        Back to home
      </a>
    </main>
  );
}
