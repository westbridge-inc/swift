/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { DARK_BLURHASH } from '../lib/images';
import { AddMorph } from './add-morph';
import { Money } from './money';
import { T } from './text';

/**
 * The real-menu row (design-100× Part 10 store): name `heading`, description
 * `caption` 2-line clamp, price `numM` right-aligned on the name's line, the
 * AddMorph beneath it. Photo only where the vendor has one — the text-first
 * row is a designed variant, never a gray placeholder wall. Rows sit in one
 * card per category with subtle dividers (elevation law: borders, not
 * shadows, for list rows).
 */
export function MenuRow({
  name,
  description,
  price,
  image,
  qty,
  soldOut = false,
  busy = false,
  onOpen,
  onAdd,
  onInc,
  onDec,
  last = false,
}: {
  name: string;
  description?: string | null;
  price: number;
  image?: string | null;
  qty: number;
  soldOut?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onInc: () => void;
  onDec: () => void;
  last?: boolean;
}) {
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={name}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            gap: space.md,
            paddingVertical: space.lg,
            borderBottomWidth: last ? 0 : 1,
            borderBottomColor: color.border.subtle,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          {image ? (
            <Image
              source={{ uri: image }}
              placeholder={{ blurhash: DARK_BLURHASH }}
              transition={150}
              style={{ width: 64, height: 64, borderRadius: radius.md, opacity: soldOut ? 0.45 : 1 }}
              contentFit="cover"
            />
          ) : null}
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="heading" tone={soldOut ? 'muted' : 'ink'} numberOfLines={1}>
              {name}
            </T>
            {description ? (
              <T variant="caption" tone="muted" numberOfLines={2}>
                {description}
              </T>
            ) : null}
            {soldOut ? (
              <T variant="micro" tone="warning" style={{ marginTop: 2 }}>
                Sold out
              </T>
            ) : null}
          </View>
          <View style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: space.sm }}>
            <Money amount={price} tone={soldOut ? 'muted' : 'brand'} />
            {soldOut ? null : <AddMorph qty={qty} busy={busy} onAdd={onAdd} onInc={onInc} onDec={onDec} />}
          </View>
        </View>
      )}
    </Pressable>
  );
}
