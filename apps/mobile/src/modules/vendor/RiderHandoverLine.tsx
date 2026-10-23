/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Avatar, T } from '../../kit';
import { HANDOVER_WORDS, riderHandoverLine, riderPhotoUrl } from './storeOrderRules';

/**
 * [STORE-DASH · O-2, owner ruling 22 Oct 19:45Z] Who the store hands a delivery to: the rider's
 * photo, first name and vehicle, checked before "Handed to rider". Nothing when the server sent
 * no rider details.
 */
export function RiderHandoverLine({ rider }: { rider: any }) {
  const line = riderHandoverLine(rider);
  if (!line) return null;
  return (
    <View testID="rider-handover-line" style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
      <Avatar name={rider?.user?.firstName ?? undefined} uri={riderPhotoUrl(rider)} size={36} />
      <View style={{ flex: 1 }}>
        <T variant="caption" tone="muted">{HANDOVER_WORDS.checkRider}</T>
        <T variant="label" weight="semibold">{line}</T>
      </View>
    </View>
  );
}
