import Link from 'next/link';
import { branchAddress, branchFactsLine, currentBranchLabel, showsBranchSwitcher, type StorefrontBrand } from '@/lib/brand-card';

/**
 * [CHAINS PR3 · owner 29 Oct 2026] "Customer can pick another branch": the brand's branches a visitor may see, each a
 * plain link to its own store page (no script needed: a <details> list). The server sends them best first.
 */
export function BranchSwitcher({ brand, fallback }: { brand: StorefrontBrand; fallback: string }) {
  if (!brand || !showsBranchSwitcher(brand)) return null;
  return (
    <details data-store-part="branches" className="mt-3 rounded-xl border border-black/5 px-3 py-2 text-[13px] leading-[18px]">
      <summary className="cursor-pointer select-none text-[var(--swift-muted)]">
        {brand.name} · {currentBranchLabel(brand, fallback)} · <span className="font-semibold text-[var(--swift-red)]">Change</span>
      </summary>
      <ul className="mt-2 flex flex-col gap-2" aria-label={`${brand.name} branches`}>
        {brand.branches.map((b) => (
          <li key={b.id}>
            {b.current ? (
              <span className="block">
                <span className="font-semibold">{b.name} (this branch)</span>
                <span className="block text-[var(--swift-muted)]">{branchAddress(b)}</span>
                <span className="block text-[var(--swift-muted)]">{branchFactsLine(b)}</span>
              </span>
            ) : (
              <Link href={`/store/${encodeURIComponent(b.slug)}`} className="block hover:underline">
                <span className="font-semibold">{b.name}</span>
                <span className="block text-[var(--swift-muted)]">{branchAddress(b)}</span>
                <span className="block text-[var(--swift-muted)]">{branchFactsLine(b)}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
