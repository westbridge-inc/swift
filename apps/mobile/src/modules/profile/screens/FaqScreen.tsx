/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Header, Screen, T } from '../../../kit';

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
    q: 'What is identity verification for?',
    a: 'Bigger orders and taxi rides need a verified ID (a quick photo of your ID plus a selfie). It keeps both sides of every trip accountable.',
  },
  {
    q: 'Can I cancel an order?',
    a: 'Yes — within the first few minutes while the order is pending. Cash orders cancel free. If you already sent an MMG payment for the order, the store refunds you directly. After the store starts preparing, cancellation may not be available.',
  },
  {
    q: 'How do refunds work with cash?',
    a: 'If something goes wrong, report it from the order. Claims are reviewed with GPS and photo evidence and settled under Swift’s guarantee policy.',
  },
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
