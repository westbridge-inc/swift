/** @jsxImportSource react */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// The mandatory ad label (spec §13): every ad surface renders
// "Ad · {advertiserName}" — app-drawn, never baked into the creative, so no
// advertiser can hide or fake it. House ads label as "Ad · Swift".

export function AdChip({ advertiserName }: { advertiserName: string }) {
  return (
    <View style={styles.chip} accessibilityLabel={`Advertisement from ${advertiserName}`}>
      <Text style={styles.text} numberOfLines={1}>
        Ad · {advertiserName}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: '70%',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 11,
    fontFamily: 'HankenMedium',
  },
});
