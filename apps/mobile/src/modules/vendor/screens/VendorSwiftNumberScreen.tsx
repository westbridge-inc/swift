/** @jsxImportSource react */
import React from 'react';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';

// Retain the export for navigation compatibility; every entry is now Weekly fee.
export function VendorSwiftNumberScreen({ route }: { route?: { params?: { ref?: string; vendorId?: string; subscriptionId?: string } } }) {
  const q = useVendorSubscription();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const pending = useStoreSwitcher((s) => s.feeContextPending);
  const params = route?.params;
  const matches = params?.vendorId === storeId && (!params?.subscriptionId || q.data?.id === params.subscriptionId);
  return <WeeklyFeeScreen key={storeId} family="vendor" sub={q.data} loading={q.isLoading} error={q.isError} refresh={q.refetch} contextPending={pending || (!!params?.vendorId && params.vendorId === storeId && !!params.subscriptionId && !q.data)} checkoutRef={matches ? params?.ref : undefined} />;
}
