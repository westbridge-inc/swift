/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T } from '../../kit';
import { BOARD_NAME_WORDS, boardNames } from './storeHandover';

/**
 * [STORE-LINK+NAMES · owner 30 Oct 21:47Z] Who the order is for, and who carries it, readable on
 * the board card itself: the customer's first name and, once assigned, the rider's first name.
 * Nothing when the reply carries no name.
 */
export function BoardNames({ order }: { order: any }) {
  const { customer, rider } = boardNames(order);
  if (!customer && !rider) return null;
  return (
    <View testID="board-names" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs, marginTop: space.xs }}>
      {customer ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <Feather name="user" size={14} color={color.text.secondary} />
          <T variant="label" weight="semibold">{BOARD_NAME_WORDS.customer(customer)}</T>
        </View>
      ) : null}
      {rider ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <MaterialCommunityIcons name="moped-outline" size={14} color={color.text.secondary} />
          <T variant="label" weight="semibold">{BOARD_NAME_WORDS.rider(rider)}</T>
        </View>
      ) : null}
    </View>
  );
}
