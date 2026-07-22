import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found' };

/** Branded 404 — without this file Next serves its bare default. Dead links
 *  (old store URLs, mistyped shares) should land somewhere useful, not a wall. */
export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-6xl font-black text-[var(--swift-red)]">404</p>
      <h1 className="mt-3 text-xl font-bold text-[var(--swift-ink)]">That page isn&apos;t here</h1>
      <p className="mt-2 max-w-md text-sm text-[var(--swift-muted)]">
        The link may be old, or the store may have moved. Everything on Swift is a click away from home.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-[var(--swift-red)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
      >
        Back to Swift
      </Link>
    </main>
  );
}
