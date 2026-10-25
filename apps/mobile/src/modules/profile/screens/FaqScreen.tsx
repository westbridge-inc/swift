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
    a: 'Cash on delivery. You pay the rider (or the store on pickup) when your order arrives — Swift never charges your card.',
  },
  {
    q: 'Does Swift add fees or markups?',
    a: 'No. Menu prices are the store’s own prices. You only pay the delivery fee shown at checkout — stores and riders pay a flat weekly subscription instead.',
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
    // [Owner ruling 24 Oct 2026] No ID for taxi rides or bigger orders: asked only after strikes or for a big promo.
    a: 'You don’t need an ID to order or to take a taxi. The app asks for one only after repeated failed deliveries or payments, or for a high-value promo code. It’s a quick photo of your government ID, no selfie, and it goes on file right away (sometimes a person checks it first).',
  },
  {
    q: 'Can I cancel an order?',
    // [Terms 2026-10-15 §7] free or refused, never a fee
    a: CANCEL_ORDER_FAQ_ANSWER,
  },
  {
    q: 'How do refunds work with cash?',
    a: 'If something goes wrong, report it from the order. Claims are reviewed with GPS and photo evidence and settled under Swift’s guarantee policy.',
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
