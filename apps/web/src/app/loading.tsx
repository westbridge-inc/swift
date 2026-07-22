/** Route-transition fallback — a branded pulse instead of a blank white flash
 *  while a segment's server data loads (felt most on 3G, the launch market's
 *  common reality). */
export default function Loading() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center" aria-busy="true" aria-label="Loading">
      <span className="relative flex h-12 w-12">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--swift-red-50)]" />
        <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--swift-red)] text-lg font-black text-white">
          S
        </span>
      </span>
    </main>
  );
}
