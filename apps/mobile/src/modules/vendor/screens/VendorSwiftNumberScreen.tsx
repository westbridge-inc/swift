/** @jsxImportSource react */
import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { useVendorProfile, useVendorSubscription } from '../../../hooks/vendorops';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { useCheckingLatest } from '../../../lib/checkingLatest';

// Retain the export for navigation compatibility; every entry is now Weekly fee.
export function VendorSwiftNumberScreen({ route }: { route?: { params?: { ref?: string; vendorId?: string; subscriptionId?: string } } }) {
  const q = useVendorSubscription();
  const checkingLatest = useCheckingLatest(q);
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const pending = useStoreSwitcher((s) => s.feeContextPending);
  const params = route?.params;
  const matches = params?.vendorId === storeId && (!params?.subscriptionId || q.data?.id === params.subscriptionId);
  // [ENTERPRISE E1b] "Pay all my branches": the business owner of several stores only (never a manager, staff or a sample preview).
  const navigation = useNavigation<any>();
  const { myRole, stores } = useVendorProfile();
  const previewing = useVendorPreview((s) => !!s.previewType);
  const payAll = myRole === 'OWNER' && stores.length > 1 && !previewing
    ? () => { const go = navigation?.push ?? navigation?.navigate; go?.('WeeklyFee', { feeFamily: 'vendor', payAll: true }); }
    : undefined;
  return <WeeklyFeeScreen key={storeId} family="vendor" sub={q.data} loading={q.isLoading} error={q.isError} refresh={q.refetch} contextPending={pending || (!!params?.vendorId && params.vendorId === storeId && !!params.subscriptionId && !q.data)} checkoutRef={matches ? params?.ref : undefined} onPayAll={payAll} checkingLatest={checkingLatest} />;
}
