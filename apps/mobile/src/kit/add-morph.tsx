/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { color, motion, radius } from '@swift/ui';
import { haptic } from '../lib/haptics';
import { T } from './text';

const SIZES = { md: { h: 32, expanded: 104, icon: 16, tick: 14 }, sm: { h: 28, expanded: 88, icon: 14, tick: 12 } } as const;

/**
 * THE add-to-cart morph (design-100× Part 10 store signature): one brand
 * circle that grows into a − qty + stepper in place, `fast` timing, shared by
 * menu rows and mart tiles so adding feels identical everywhere. Selection
 * haptic on every tick (9.5). When an item has options, the collapsed + opens
 * the detail instead (options can't be picked from a button).
 */
export function AddMorph({
  qty,
  onAdd,
  onInc,
  onDec,
  busy = false,
  disabled = false,
  size = 'md',
}: {
  qty: number;
  onAdd: () => void;
  onInc: () => void;
  onDec: () => void;
  busy?: boolean;
  disabled?: boolean;
  size?: keyof typeof SIZES;
}) {
  const dim = SIZES[size];
  const open = qty > 0;
  const width = useSharedValue(open ? dim.expanded : dim.h);

  useEffect(() => {
    width.value = withTiming(open ? dim.expanded : dim.h, { duration: motion.duration.fast });
  }, [open, width, dim]);

  const frame = useAnimatedStyle(() => ({ width: width.value }));

  return (
    <Animated.View
      style={[
        {
          height: dim.h,
          borderRadius: radius.full,
          backgroundColor: color.brand[500],
          overflow: 'hidden',
          opacity: disabled ? 0.38 : busy ? 0.7 : 1,
        },
        frame,
      ]}
    >
      {open ? (
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable
            onPress={() => {
              haptic.select();
              onDec();
            }}
            disabled={busy || disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Decrease quantity"
            style={{ width: dim.h, height: dim.h, alignItems: 'center', justifyContent: 'center' }}
          >
            <Feather name="minus" size={dim.tick} color={color.white} />
          </Pressable>
          <T variant="bodyStrong" tone="onBrand" accessibilityLiveRegion="polite">
            {qty}
          </T>
          <Pressable
            onPress={() => {
              haptic.select();
              onInc();
            }}
            disabled={busy || disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Increase quantity"
            style={{ width: dim.h, height: dim.h, alignItems: 'center', justifyContent: 'center' }}
          >
            <Feather name="plus" size={dim.tick} color={color.white} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => {
            haptic.select();
            onAdd();
          }}
          disabled={busy || disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Add to cart"
          style={{ width: dim.h, height: dim.h, alignItems: 'center', justifyContent: 'center' }}
        >
          <Feather name="plus" size={dim.icon} color={color.white} />
        </Pressable>
      )}
    </Animated.View>
  );
}
