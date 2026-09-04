/** @jsxImportSource react */
import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { Card, EmptyState, ErrorState, LoadingBlock, T, TonePill } from '../../../kit';
import { useMyAdvertisers, useAdvertiserInvoices } from '../../../hooks/advertiser';
import { moneyOrDash as money } from '../../../lib/money';

// §14.5 — invoices. Every figure is the server's; refunds show against the
// invoice they refunded.

const INVOICE_TONE: Record<string, 'brand' | 'success' | 'neutral' | 'error'> = {
  UNPAID: 'brand',
  PAID: 'success',
  VOID: 'neutral',
  REFUNDED: 'error',
  PARTIALLY_REFUNDED: 'error',
};

export function AdvertiserBillingScreen() {
  const insets = useSafeAreaInsets();
  const me = useMyAdvertisers();
  const advertiser = (me.data ?? [])[0];
  const invoices = useAdvertiserInvoices(advertiser?.id);
  const rows = invoices.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
      <T variant="title" style={{ paddingHorizontal: space['2xl'], paddingTop: space.lg }}>
        Billing
      </T>
      <ScrollView
        contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }}
        refreshControl={<RefreshControl refreshing={invoices.isRefetching} onRefresh={() => invoices.refetch()} tintColor={color.brand[500]} />}
      >
        {invoices.isLoading ? (
          <LoadingBlock style={{ paddingTop: 64 }} />
        ) : (invoices.isError || me.isError) && rows.length === 0 ? (
          // [WR-030] An outage is not "No invoices yet".
          <ErrorState onRetry={() => { me.refetch(); invoices.refetch(); }} style={{ paddingTop: 48 }} />
        ) : rows.length === 0 ? (
          <EmptyState icon="file-text" title="No invoices yet" body="Invoices appear when you book a campaign." style={{ paddingTop: 48 }} />
        ) : (
          <View style={{ gap: space.lg }}>
            {rows.map((inv: any) => (
              <Card key={inv.id} style={{ padding: space.xl }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T variant="body" weight="semibold">
                    {inv.number}
                  </T>
                  <TonePill label={inv.status.replace('_', ' ')} tone={INVOICE_TONE[inv.status] ?? 'neutral'} />
                </View>
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  {inv.campaign}
                </T>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.md }}>
                  <T variant="label" weight="semibold">
                    {money(inv.amount, inv.currency)}
                  </T>
                  {Number(inv.refundedAmount) > 0 ? (
                    <T variant="caption" style={{ color: color.error }}>
                      −{money(inv.refundedAmount, inv.currency)} refunded
                    </T>
                  ) : null}
                </View>
                {inv.status === 'UNPAID' ? (
                  <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                    Pay via MMG or bank transfer; the operator confirms receipt and your campaign moves to review.
                  </T>
                ) : null}
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
