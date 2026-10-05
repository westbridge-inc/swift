/**
 * A refused ride request the passenger can fix in one step opens a door to
 * that step, never a dead end (§5). Only the two account gates the ride
 * request enforces qualify: the profile photo the driver sees, and the
 * one-time ID check before a first ride.
 */
export type TaxiDoor = 'selfie' | 'identity' | null;

export function taxiDoorFor(code: string | null | undefined): TaxiDoor {
  if (code === 'SELFIE_REQUIRED') return 'selfie';
  if (code === 'ID_VERIFICATION_REQUIRED') return 'identity';
  return null;
}
