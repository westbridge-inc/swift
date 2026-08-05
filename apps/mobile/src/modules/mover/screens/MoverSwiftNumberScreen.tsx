/** @jsxImportSource react */
import React from 'react';
import { Header, Screen } from '../../../kit';
import { useMoverKind, useMoverSubscription } from '../../../hooks';
import { SwiftNumberView } from '../../../components/billing/BillingSurfaces';

/** "My Swift Number" for the earner — the payer's SAN, wallet, amount due and
 *  agent-cash steps. Data is the same GET /rider|/driver/subscription payload
 *  the Earnings + Account screens already read. */
export function MoverSwiftNumberScreen() {
  const { kind, loading: kindLoading } = useMoverKind();
  const q = useMoverSubscription(kind);
  return (
    <Screen>
      <Header title="My Swift Number" />
      <SwiftNumberView
        sub={q.data}
        loading={kindLoading || q.isLoading}
        error={q.isError}
        onRetry={() => q.refetch()}
      />
    </Screen>
  );
}
