import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from '../../../kit';
import { money } from '../../../lib/money';
import { owesStore } from './offer-earnings';

/**
 * [WS-6.0] THE CASH MATH on the offer card — the mover's own exposure, in words, every number server-computed
 * (`cashMathForOffer`): what to collect at the door and, only on a store order, the store's share. [promo-film finding
 * 2 Nov 2026] A taxi ride or a courier job pays no store (payToVendor 0): the card said "Pay the store $0" there; it
 * now says what the mover keeps. Absent cash math (MMG, or a split that does not reconcile) renders nothing.
 */
export function OfferCashMath({ cashMath, vendorName }: {
  cashMath: { collectFromCustomer: number; payToVendor: number; youKeep: number } | null | undefined;
  vendorName?: string;
}) {
  if (!cashMath) return null;
  return (
    <View
      style={{
        marginTop: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: color.surface.subtle,
        gap: 2,
      }}
    >
      <T variant="caption" weight="semibold">
        Cash job — collect {money(cashMath.collectFromCustomer)} from the customer
      </T>
      {owesStore(cashMath) ? (
        <T variant="caption" tone="muted">
          Pay {vendorName ?? 'the store'} {money(cashMath.payToVendor)} · you keep {money(cashMath.youKeep)}
        </T>
      ) : (
        <T variant="caption" tone="muted">You keep {money(cashMath.youKeep)}</T>
      )}
    </View>
  );
}
