/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import type { CartPaymentCapabilities } from '@swift/types';
import { T } from '../../kit';
import {
  cartPaymentOptions,
  type CartPaymentChoice,
  type CartPaymentSelection,
} from './cartPayment';

export function CartPaymentOptions({
  capabilities,
  selection,
  appointmentOnly,
  pickup,
  onSelect,
}: {
  capabilities: CartPaymentCapabilities;
  selection: CartPaymentSelection;
  appointmentOnly: boolean;
  pickup: boolean;
  onSelect: (method: CartPaymentChoice) => void;
}) {
  return (
    <View style={{ gap: space.sm }}>
      {cartPaymentOptions(capabilities, { appointmentOnly, pickup }).map((option) => {
        const active = selection.method === option.key;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityLabel={option.title}
            accessibilityState={{ checked: active }}
            onPress={() => onSelect(option.key)}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                padding: space.lg,
                borderRadius: radius.md,
                borderWidth: active ? 1.5 : 1,
                borderColor: active ? color.brand[500] : color.border.strong,
                backgroundColor: active ? color.brand[50] : color.surface.base,
              }}
            >
              <Feather name={option.icon} size={18} color={active ? color.brand[600] : color.text.muted} />
              <View style={{ flex: 1 }}>
                <T variant="label" weight="semibold" tone={active ? 'deep' : 'ink'}>
                  {option.title}
                </T>
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  {option.sub}
                </T>
              </View>
              <Feather name={active ? 'check-circle' : 'circle'} size={18} color={active ? color.brand[500] : color.border.strong} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
