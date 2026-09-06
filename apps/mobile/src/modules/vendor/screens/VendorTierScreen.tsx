/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Card, ErrorState, Header, LinkText, LoadingBlock, Screen, T, TonePill } from '../../../kit';
import { useVendorTier } from '../../../hooks/vendorops';
import { money } from '../../../lib/money';
import { capLine, registrationLine, tierLabel, type TierView } from '../tier-view';

function Bar({ fraction, hot }: { fraction: number; hot: boolean }) {
  return (
    <View style={{ height: 8, borderRadius: radius.full, backgroundColor: color.surface.sunken, overflow: 'hidden', marginTop: 4 }}>
      <View style={{ width: `${Math.round(fraction * 100)}%`, height: 8, backgroundColor: hot ? color.warning : color.success }} />
    </View>
  );
}

/**
 * [DOC-1 §3.6 · P3-2] Seller status — the store's tier, its caps and usage, and exactly what lifts
 * the limits: a business registration certificate on file. Everything shown is the server's.
 */
export function VendorTierScreen({ navigation }: { navigation?: { navigate?: (s: string, p?: Record<string, unknown>) => void } }) {
  const q = useVendorTier<TierView>();
  const t = q.data as TierView | undefined;
  return (
    <Screen>
      <Header title="Seller status" />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={() => void q.refetch()} message="Couldn't load your seller status." /> : null}
        {t ? (
          <>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="title">Your tier</T>
                <TonePill label={tierLabel(t).label} tone={tierLabel(t).tone} />
              </View>
              {t.capped ? (
                <View style={{ marginTop: space.sm, gap: space.sm }}>
                  {(() => { const l = capLine(t.usage.ordersToday, t.caps.ordersPerDay, 'Orders today'); return (<View><T variant="caption">{l.text}</T><Bar fraction={l.fraction} hot={l.fraction >= t.caps.nudgeAtFraction} /></View>); })()}
                  {(() => { const l = capLine(t.usage.grossThisWeek, t.caps.grossPerWeek, 'Sales this week'); return (<View><T variant="caption">{`Sales this week: ${money(t.usage.grossThisWeek)} of ${money(t.caps.grossPerWeek)}`}</T><Bar fraction={l.fraction} hot={l.fraction >= t.caps.nudgeAtFraction} /></View>); })()}
                  {t.nearCap ? <T variant="caption" style={{ color: color.warning }}>You are near a limit. Orders past it are refused until the day or week rolls over.</T> : null}
                  <T variant="caption" style={{ color: color.text.secondary }}>Promoted placement opens once your business is registered.</T>
                </View>
              ) : (
                <T variant="caption" style={{ color: color.text.secondary, marginTop: space.sm }}>No order or sales limits apply. Promoted placement is open to you.</T>
              )}
            </Card>
            <Card>
              <T variant="title">Business registration</T>
              <T variant="caption" style={{ marginTop: 4 }}>{registrationLine(t)}</T>
              {t.declaration ? <T variant="caption" style={{ color: color.text.secondary, marginTop: 4 }}>Self-declaration {t.declaration.status.toLowerCase().replace(/_/g, ' ')}{t.declaration.expiresAt ? ` · valid to ${new Date(t.declaration.expiresAt).toLocaleDateString()}` : ''}</T> : null}
              {t.capped ? (
                <View style={{ marginTop: space.sm, gap: 4 }}>
                  <T variant="caption" style={{ fontWeight: '700' }}>How to lift the limits</T>
                  <T variant="caption">1. Register your business name with the Deeds and Commercial Registries Authority (DCRA).</T>
                  <T variant="caption">2. Get the Business Registration Certificate.</T>
                  <T variant="caption">3. Upload it under your documents. The limits lift the day it is verified, and we tell you.</T>
                  <LinkText label="Need help registering? Ask a person" onPress={() => navigation?.navigate?.('GetHelp', { category: 'ACCOUNT', subject: 'Registering my business' })} />
                </View>
              ) : null}
            </Card>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
