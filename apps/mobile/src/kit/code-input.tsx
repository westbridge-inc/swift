/** @jsxImportSource react */
import React, { useEffect, useRef } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { color, motion, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * The code ceremony (design-100× Part 5 moment 4): PIN / start-code entry as
 * large digit boxes — the active box wears a brand border, digits render in
 * the display face, and a failed verify shakes the row (±6dp ×3, fast) while
 * the digits flush error. One hidden input drives it; the number pad stays.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  error = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  error?: boolean;
  autoFocus?: boolean;
}) {
  const input = useRef<TextInput>(null);
  const shake = useSharedValue(0);

  useEffect(() => {
    if (error) {
      shake.value = withSequence(
        withTiming(-6, { duration: motion.duration.instant }),
        withTiming(6, { duration: motion.duration.instant }),
        withTiming(-6, { duration: motion.duration.instant }),
        withTiming(6, { duration: motion.duration.instant }),
        withTiming(0, { duration: motion.duration.instant }),
      );
    }
  }, [error, shake]);

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const digits = value.slice(0, length).split('');
  const active = Math.min(digits.length, length - 1);

  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Code entry">
      <Animated.View style={[{ flexDirection: 'row', gap: space.sm, justifyContent: 'center' }, row]}>
        {Array.from({ length }, (_, i) => {
          const filled = i < digits.length;
          const isActive = i === active && digits.length < length;
          return (
            <View
              key={i}
              style={{
                flex: 1,
                maxWidth: 52,
                height: 60,
                borderRadius: radius.md,
                borderWidth: isActive ? 2 : 1,
                borderColor: error ? color.error : isActive ? color.brand[500] : color.border.strong,
                backgroundColor: color.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T variant="displayXl" tone={error ? 'error' : 'ink'}>
                {filled ? digits[i] : ''}
              </T>
            </View>
          );
        })}
      </Animated.View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus={autoFocus}
        style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />
    </Pressable>
  );
}
