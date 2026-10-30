// ---------------------------------------------------------------------------
// [CHAINS PR3 · owner 29 Oct 2026] "One brand card ('Royal Castle') opening the nearest open branch that delivers to
// them; customer can pick another branch." The words a store card and the storefront's branch switcher say. The
// server chooses the branch a brand card opens (open and delivering to the customer first); these only say it.
// This file is the phone's AND the website's (apps/web/src/lib/brand-card.ts is a byte-identical copy, pinned by
// a test): one set of words on both. No imports, on purpose.
// ---------------------------------------------------------------------------

/** What a store card carries when it stands for a whole chain (null: a store on its own). */
export type BrandCard = { name: string; branches: number } | null | undefined;

/** A branch in the storefront's switcher, best first (the server's order). */
export type BrandBranch = {
  id: string;
  name: string;
  slug: string;
  addressLine1: string;
  city: string;
  isCurrentlyOpen: boolean;
  acceptingOrders: boolean;
  distanceKm: number | null;
  delivers: boolean | null;
  current: boolean;
};

export type StorefrontBrand = { name: string; branches: BrandBranch[] } | null | undefined;

/** The card's title: the brand's name when the card stands for a chain, else the store's own. */
export function brandTitle(name: string, brand: BrandCard): string {
  return brand && brand.name.trim() ? brand.name : name;
}

/** The card's branch line: which branch it opens and how many there are ("12 Camp Street · 4 branches"). */
export function brandLine(brand: BrandCard, place: string | null | undefined): string | null {
  if (!brand) return null;
  const where = place && place.trim() ? place.trim() : null;
  const count = brand.branches > 1 ? `${brand.branches} branches` : null;
  return [where, count].filter(Boolean).join(' · ') || null;
}

/** Whether the storefront offers another branch (a brand with two or more branches the customer may see). */
export function showsBranchSwitcher(brand: StorefrontBrand): boolean {
  return !!brand && brand.branches.length >= 2;
}

/** The storefront row under the address: "12 Camp Street branch". */
export function currentBranchLabel(brand: StorefrontBrand, fallback: string): string {
  const here = brand?.branches.find((b) => b.current);
  const place = here?.addressLine1?.trim() || fallback.trim();
  return `${place} branch`;
}

/** "Open" while it takes orders, else "Closed". */
export function branchOpenWords(branch: Pick<BrandBranch, 'isCurrentlyOpen' | 'acceptingOrders'>): string {
  return branch.isCurrentlyOpen && branch.acceptingOrders ? 'Open' : 'Closed';
}

/** Whether it delivers to the customer's place, when the place is known. */
export function branchDeliversWords(delivers: boolean | null | undefined): string | null {
  if (delivers === true) return 'Delivers to you';
  if (delivers === false) return 'Doesn’t deliver to you';
  return null;
}

/** One branch's line in the switcher: "Open · 1.2 km · Delivers to you". */
export function branchFactsLine(branch: BrandBranch): string {
  const km = branch.distanceKm == null ? null : `${branch.distanceKm.toFixed(1)} km`;
  return [branchOpenWords(branch), km, branchDeliversWords(branch.delivers)].filter(Boolean).join(' · ');
}

/** The branch's address as one line. */
export function branchAddress(branch: Pick<BrandBranch, 'addressLine1' | 'city'>): string {
  return [branch.addressLine1, branch.city].map((s) => (s ?? '').trim()).filter(Boolean).join(', ');
}
