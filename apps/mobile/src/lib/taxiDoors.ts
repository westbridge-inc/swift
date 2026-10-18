/**
 * A refused ride request the passenger can fix in one step opens a door to
 * that step, never a dead end (§5). One account gate qualifies: the one-time
 * ID check before a first ride. [Owner ruling 16 Oct 2026] Customers take no
 * photos, so there is no photo door (the server no longer asks for one).
 */
export type TaxiDoor = 'identity' | null;

export function taxiDoorFor(code: string | null | undefined): TaxiDoor {
  if (code === 'ID_VERIFICATION_REQUIRED') return 'identity';
  return null;
}
