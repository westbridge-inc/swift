/** @jsxImportSource react */
import React from 'react';
import { ScrollView } from 'react-native';
import { color, space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, Screen, T } from '../../../kit';
import { useVendorTier } from '../../../hooks/vendorops';
import { NO_LIMITS_LINE, WAYS_IN_LINE, registrationLine, type TierView } from '../tier-view';

/**
 * [DOC-1 §3.6 · P3-2] Seller status. [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a)] The self-declared tier, its caps and
 * what lifted them are removed: no row opens this screen any more; it stays for notices sent before (their tap lands
 * here) and says what is true for every store: no limits, and where the store's registration stands.
 */
export function VendorTierScreen() {
  const q = useVendorTier<TierView>();
  const t = q.data as TierView | undefined;
  return (
    <Screen>
      <Header title="Seller status" />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={() => void q.refetch()} message="Couldn't load your seller status." /> : null}
        {t ? (
          <Card>
            <T variant="title">Business registration</T>
            <T variant="caption" style={{ marginTop: 4 }}>{registrationLine(t)}</T>
            <T variant="caption" style={{ color: color.text.secondary, marginTop: space.sm }}>{NO_LIMITS_LINE}</T>
            <T variant="caption" style={{ color: color.text.secondary, marginTop: 4 }}>{WAYS_IN_LINE}</T>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
