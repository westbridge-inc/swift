/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, fontSize, space } from '@swift/ui';
import { Card, EmptyState, ErrorState, Header, LinkText, LoadingBlock, Screen, T, TonePill } from '../../../kit';
import { useMoverClaims, useMoverKind } from '../../../hooks';
import { money } from '../../../lib/money';
import { dateLabel } from '../shared';
import { claimStatus, evidenceLine, flagHint, reasonLabel, type ClaimView } from '../claims-view';

/**
 * [DOC-1 §31.4 · P31-1] Guarantee claims — the rider's own view of a policy that is
 * written, funded and capped: each claim's status, the evidence bundle as it was filed,
 * when Swift pays an approved claim, and whether their protection is suspended. Everything
 * shown is the server's; the screen decides nothing.
 */
export function ClaimsScreen({ navigation }: { navigation?: { navigate?: (s: string, p?: Record<string, unknown>) => void } }) {
  const { kind } = useMoverKind();
  const q = useMoverClaims<{ claims: ClaimView[]; suspended: boolean; suspendedAt: string | null }>(kind);
  const data = q.data as { claims: ClaimView[]; suspended: boolean; suspendedAt: string | null } | undefined;
  return (
    <Screen>
      <Header title="Guarantee claims" />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={() => void q.refetch()} message="Couldn't load your claims." /> : null}
        {data?.suspended ? (
          <Card style={{ borderColor: color.error, borderWidth: 1 }}>
            <T variant="body" style={{ fontWeight: '700' }}>Your loss protection is suspended</T>
            <T variant="caption" style={{ color: color.text.secondary }}>
              Claims you file are reviewed by a person before Swift pays them. You can ask for a review of this decision.
            </T>
            <LinkText label="Get help" onPress={() => navigation?.navigate?.('GetHelp', { category: 'ACCOUNT', subject: 'Loss protection suspended' })} />
          </Card>
        ) : null}
        {data && data.claims.length === 0 ? (
          <EmptyState icon="shield" title="No claims" body="When a customer doesn't pay at the door on a cash order, the guarantee claim you file shows here." />
        ) : null}
        {data?.claims.map((c: ClaimView) => {
          const st = claimStatus(c.status);
          const hints = c.flags.map(flagHint).filter((h: string | null): h is string => Boolean(h));
          return (
            <Card key={c.id} accessibilityLabel={`Claim ${money(Number(c.amount))} ${st.label}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T variant="title" style={{ fontSize: fontSize.lg }}>{money(Number(c.amount))}</T>
                <TonePill label={st.label} tone={st.tone} />
              </View>
              <T variant="caption" style={{ color: color.text.secondary }}>{reasonLabel(c.reason)} · filed {dateLabel(c.filedAt)}</T>
              {c.settleBy && c.status !== 'PAID' ? <T variant="caption">Swift pays you by {dateLabel(c.settleBy)}</T> : null}
              {c.paidAt ? <T variant="caption">Paid {dateLabel(c.paidAt)}{c.paymentRef ? ` · ref ${c.paymentRef}` : ''}</T> : null}
              {c.evidence ? (
                <View style={{ marginTop: space.sm, gap: 4 }}>
                  <T variant="caption" style={{ fontWeight: '700' }}>Evidence</T>
                  {c.evidence.items.map((item: { key: string; present: boolean; required: boolean }) => {
                    const line = evidenceLine(item);
                    return (
                      <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Feather name={line.state === 'ok' ? 'check-circle' : line.state === 'missing' ? 'alert-circle' : 'circle'} size={14} color={line.state === 'ok' ? color.success : line.state === 'missing' ? color.error : color.text.secondary} />
                        <T variant="caption" style={{ color: line.state === 'missing' ? color.error : color.text.primary }}>{line.label}{line.state === 'optional' ? ' (optional)' : ''}</T>
                      </View>
                    );
                  })}
                </View>
              ) : null}
              {hints.map((h: string) => <T key={h} variant="caption" style={{ color: color.text.secondary, marginTop: 4 }}>{h}</T>)}
            </Card>
          );
        })}
        <LinkText label="Something wrong with a claim? Get help" onPress={() => navigation?.navigate?.('GetHelp', { category: 'PAYMENT', subject: 'Delivery guarantee claim' })} />
      </ScrollView>
    </Screen>
  );
}
