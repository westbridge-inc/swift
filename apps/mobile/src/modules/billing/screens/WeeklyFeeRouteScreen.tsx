/** @jsxImportSource react */
import React from 'react';
import { useAuthStore } from '../../../stores/authStore';
import { VendorSwiftNumberScreen } from '../../vendor/screens/VendorSwiftNumberScreen';
import { MoverSwiftNumberScreen } from '../../mover/screens/MoverSwiftNumberScreen';
import { VendorPayAllScreen } from '../../vendor/screens/VendorPayAllScreen';

/** A notification's paying family is independent of the currently open app.
 * Resolve it before mounting either family's subscription/polling hooks.
 * [ENTERPRISE E1b] `payAll`: the store owner's "Pay all my branches" (from their Weekly fee screen, or a pay-all
 * payment's notice, whose `ref` it follows). Kept on this route so it opens from every partner stack. */
export function WeeklyFeeRouteScreen({ route }: {
  route?: { params?: { feeFamily?: 'vendor' | 'mover'; vendorId?: string; subscriptionId?: string; ref?: string; payAll?: boolean } };
}) {
  const intent = useAuthStore((s) => s.intent);
  if (route?.params?.payAll === true) return <VendorPayAllScreen checkoutRef={route.params.ref} />;
  const family = route?.params?.feeFamily ?? (route?.params?.vendorId ? 'vendor' : intent === 'vendor' ? 'vendor' : 'mover');
  return family === 'vendor' ? <VendorSwiftNumberScreen route={route} /> : <MoverSwiftNumberScreen route={route} />;
}
