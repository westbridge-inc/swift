/** One store as GET /vendor/profile returns it, inside `data.vendors` (the response's top level is the owner). */
export type ProfileStore = {
  id: string;
  name: string;
  vendorType: string;
  city?: string | null;
  description?: string | null;
  isVerified?: boolean;
  activationValidUntil?: string | null;
};
export type ProfileData = { vendors?: ProfileStore[] };

/**
 * The selected store's row. GET /vendor/profile answers `{ id, userId, vendors, myRole }`, so the store's name, type,
 * city and check live on `data.vendors[i]`, never on `data` itself (reading `data.isVerified` always said "pending").
 */
export function selectedProfileStore(data: ProfileData | undefined, storeId: string | null): ProfileStore | undefined {
  const vendors = data?.vendors ?? [];
  return vendors.find((v) => v.id === storeId) ?? (vendors.length === 1 ? vendors[0] : undefined);
}

/**
 * [GUARDRAILS §7(4)] Say what a person did, and only while it still holds: "checked" only when the activation check
 * passed AND none of the checked documents has lapsed since (activationValidUntil = the earliest expiry among them).
 */
export function storeCheckLabel(store: Pick<ProfileStore, 'isVerified' | 'activationValidUntil'>, now = new Date()): string {
  if (!store.isVerified) return 'Waiting for Swift to check your documents';
  if (store.activationValidUntil && new Date(store.activationValidUntil).getTime() <= now.getTime()) {
    return 'A checked document has expired: renew it in the Swift app';
  }
  return 'Documents checked by Swift';
}
