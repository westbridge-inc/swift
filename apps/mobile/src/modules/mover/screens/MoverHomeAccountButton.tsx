/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { cardShadow } from '../../../kit';
import { dk } from '../surface';

export function MoverHomeAccountButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Account"
      onPress={onPress}
      hitSlop={8}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: dk.card,
              borderWidth: 1,
              borderColor: dk.line,
              opacity: pressed ? 0.7 : 1,
            },
            cardShadow,
          ]}
        >
          <Feather name="user" size={17} color={dk.text} />
        </View>
      )}
    </Pressable>
  );
}
