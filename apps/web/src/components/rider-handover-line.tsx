'use client';

// The app's own O-2 words and checks (plain file, imported as is).
import { HANDOVER_WORDS, riderHandoverLine, riderPhotoUrl } from '../../../mobile/src/modules/vendor/storeOrderRules';
import type { VendorOrder } from '@/lib/vendor-api';

/**
 * [STORE-DASH · O-2, owner ruling 22 Oct 19:45Z] Who the store hands a delivery to: the rider's
 * photo, first name and vehicle, checked before "Handed to rider" (the phone's RiderHandoverLine).
 * Nothing when the server sent no rider details.
 */
export function RiderHandoverLine({ rider }: { rider: VendorOrder['rider'] }) {
  const line = riderHandoverLine(rider);
  if (!line) return null;
  const photo = riderPhotoUrl(rider);
  const initial = (rider?.user?.firstName ?? '').trim().charAt(0).toUpperCase() || '•';
  return (
    <div data-testid="rider-handover-line" className="flex items-center gap-3 rounded-lg bg-[var(--swift-subtle)] p-2">
      {photo
        // A signed per-rider address: a plain <img>, never the image optimiser's cache.
        ? <img src={photo} alt={`Photo of ${rider?.user?.firstName ?? 'the rider'}`} width={36} height={36} className="h-9 w-9 shrink-0 rounded-full object-cover" />
        : <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--swift-red)]/10 font-bold text-[var(--swift-red)]">{initial}</span>}
      <span className="min-w-0">
        <span className="block text-xs text-[var(--swift-muted)]">{HANDOVER_WORDS.checkRider}</span>
        <span className="block break-words text-sm font-semibold">{line}</span>
      </span>
    </div>
  );
}
