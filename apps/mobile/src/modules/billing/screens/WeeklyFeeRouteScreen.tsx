/** @jsxImportSource react */
import React from 'react';
import { useAuthStore } from '../../../stores/authStore';
import { VendorSwiftNumberScreen } from '../../vendor/screens/VendorSwiftNumberScreen';
import { MoverSwiftNumberScreen } from '../../mover/screens/MoverSwiftNumberScreen';

/** A notification's paying family is independent of the currently open app.
 * Resolve it before mounting either family's subscription/polling hooks. */
export function WeeklyFeeRouteScreen({ route }: {
  route?: { params?: { feeFamily?: 'vendor' | 'mover'; vendorId?: string; subscriptionId?: string; ref?: string } };
}) {
  const intent = useAuthStore((s) => s.intent);
  const family = route?.params?.feeFamily ?? (route?.params?.vendorId ? 'vendor' : intent === 'vendor' ? 'vendor' : 'mover');
  return family === 'vendor' ? <VendorSwiftNumberScreen route={route} /> : <MoverSwiftNumberScreen route={route} />;
}
