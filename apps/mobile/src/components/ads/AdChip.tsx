/** @jsxImportSource react */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';

// The mandatory ad label (spec §13): every ad surface renders
// "Ad · {advertiserName}" — app-drawn, never baked into the creative, so no
// advertiser can hide or fake it. House ads label as "Ad · Swift".
// Dressed in the `micro` step on the shared media-chip scrim (design-100×).

export function AdChip({ advertiserName }: { advertiserName: string }) {
  return (
    <View style={styles.chip} accessibilityLabel={`Advertisement from ${advertiserName}`}>
      <T variant="micro" style={styles.text} numberOfLines={1}>
        Ad · {advertiserName}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    top: space.sm,
    left: space.sm,
    backgroundColor: color.mediaChip,
    borderRadius: radius.full,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    maxWidth: '70%',
  },
  text: {
    color: color.white,
  },
});
