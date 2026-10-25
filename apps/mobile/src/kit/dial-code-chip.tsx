/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, space } from '@swift/ui';
import { T } from './text';
import { flagEmoji } from '../lib/flags';

/** The fixed calling-code chip that sits in a phone field's right slot —
 *  flag + dial code on the brand tint, exactly as sign-in draws it. A phone
 *  field that shows it takes LOCAL digits only; the caller composes E.164. */
export function DialCodeChip({ countryCode, dialCode, countryName }: { countryCode: string; dialCode: string; countryName: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${countryName} calling code ${dialCode}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        borderRadius: 9999,
        backgroundColor: color.brand[50],
      }}
    >
      <T variant="label">{flagEmoji(countryCode)}</T>
      <T variant="label" weight="semibold" tone="deep">{dialCode}</T>
    </View>
  );
}
