/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Header, Screen, T } from '../../../kit';
import { TAXI_DOCUMENTS_FAQ } from '../../../components/onboarding/taxiDocumentCopy';
import { CANCEL_ORDER_FAQ_ANSWER } from '../../../lib/cancelPolicyCopy';

// Kit FAQ (54): accordion rows. Static product truths — no invented data.
const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do I pay?',
    a: 'Cash when your order arrives: you pay the rider, or the store on pickup. Where a store offers MMG, you can pay the store by MMG instead. Swift never charges your card.',
  },
  {
    q: 'Does Swift add fees or markups?',
    a: 'No. Menu prices are the store’s own prices. You only pay the delivery fee shown at checkout — stores and riders pay a flat weekly subscription instead.',
  },
  {
    // [OWNER 5 Nov 2026] MMG checkout stays; in person is recorded by a person, directly to the company.
    q: 'How do stores, riders and drivers pay the weekly fee?',
    a: 'In the Swift app or on swiftgy.com, on MMG’s checkout page. Or in person, directly to Westbridge Inc., by cash, cheque or bank transfer: open Get help to arrange it. A cheque counts once it clears, and you get a receipt. Never pay through an agent or anyone else.',
  },
  {
    q: 'Where does Swift deliver?',
    a: 'We’re launching across Guyana, starting with Georgetown and surrounding areas. Stores within range appear automatically.',
  },
  {
    q: 'How do I track my order?',
    a: 'Open the order from Home or My Orders. You’ll see the live map, the rider’s position, and every stage from the kitchen to your gate.',
  },
  {
    q: 'Does Swift need my ID?',
    // [Owner ruling 8 Oct 2026 — CUSTOMER ID] on file at once, no selfie. [16 Oct] Customers take no photos, taxi included.
    // [Owner ruling 24 Oct 2026] No ID for taxi rides or bigger orders. [CHECKLIST-LEGAL · owner 1 Nov 2026 (b)] No ID at all.
    a: 'No. Swift never asks a customer for an ID or a photo, for orders, taxi rides or promo codes.',
  },
  {
    q: 'Can I cancel an order?',
    // [Terms 2026-10-15 §7] free or refused, never a fee
    a: CANCEL_ORDER_FAQ_ANSWER,
  },
  {
    q: 'How do refunds work with cash?',
    a: 'Paying cash, you pay only when the order is handed over, so a cancelled order has nothing to refund. If something is wrong with an order you received, report it from the order. Any refund is made by the business: order money never passes through Swift, so Swift cannot send it, but we help you get an answer.',
  },
  // [Owner ruling 11 Oct 2026] the two licences, said plainly
  TAXI_DOCUMENTS_FAQ,
];

export function FaqScreen() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <Screen>
      <Header title="FAQ" />
      <ScrollView contentContainerStyle={{ padding: space['2xl'], gap: space.md }}>
        {FAQS.map((f, i) => {
          const on = open === i;
          return (
            <Card key={f.q} style={{ padding: space.lg }}>
              <Pressable onPress={() => setOpen(on ? null : i)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <T variant="body" weight="semibold" style={{ flex: 1 }}>
                  {f.q}
                </T>
                <Feather name={on ? 'chevron-up' : 'chevron-down'} size={18} color={color.text.muted} />
              </Pressable>
              {on ? (
                <T variant="label" tone="muted" style={{ marginTop: space.md, lineHeight: 21 }}>
                  {f.a}
                </T>
              ) : null}
            </Card>
          );
        })}
        <View style={{ height: space['2xl'] }} />
      </ScrollView>
    </Screen>
  );
}
