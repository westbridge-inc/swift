/** @jsxImportSource react */
import React from 'react';
import { Screen } from '../../../kit';
import { SubHeader } from '../shared';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { SwiftNumberView } from '../../../components/billing/BillingSurfaces';

/** "My Swift Number" for the store owner — the same SAN + agent-cash pay block
 *  the earner sees, off GET /vendor/subscription. Owner-only (billing is
 *  owner-scoped); reached from the owner's account subscription card. */
export function VendorSwiftNumberScreen({ navigation }: any) {
  const q = useVendorSubscription();
  return (
    <Screen>
      <SubHeader title="My Swift Number" navigation={navigation} />
      <SwiftNumberView sub={q.data} loading={q.isLoading} error={q.isError} onRetry={() => q.refetch()} />
    </Screen>
  );
}
