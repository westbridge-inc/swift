/** @jsxImportSource react */
import React from 'react';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';

// Retain the export for navigation compatibility; every entry is now Weekly fee.
export function VendorSwiftNumberScreen({ route }: { route?: { params?: { ref?: string } } }) {
  const q = useVendorSubscription();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return <WeeklyFeeScreen key={storeId} family="vendor" sub={q.data} loading={q.isLoading} error={q.isError} refresh={q.refetch} checkoutRef={route?.params?.ref} />;
}
