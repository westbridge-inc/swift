/** @jsxImportSource react */
import React from 'react';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { DecorativeIcon, LinkText, PillButton, PopupCard, PopupTitle, T } from '../kit';
import { PRIME_COPY, markPrimeAsked, usePrimeStore } from '../services/notification-priming';
import { registerDeviceForPush } from '../services/push';

// The one-line priming card [first-open SO-5]: shows once, at an in-context
// moment (order placed / application submitted / store created), BEFORE the
// OS dialog. "Not now" is a real answer — the app keeps working untouched.
export function PermissionPrimeSheet() {
  const moment = usePrimeStore((s) => s.visibleMoment);
  const dismiss = usePrimeStore((s) => s.dismiss);

  const answer = (turnOn: boolean) => {
    markPrimeAsked();
    dismiss();
    if (turnOn) void registerDeviceForPush();
  };

  return (
    <PopupCard visible={moment != null} onClose={() => answer(false)}>
      <DecorativeIcon
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: color.brand[50],
          marginBottom: space.md,
        }}
      >
        <Feather name="bell" size={20} color={color.brand[600]} />
      </DecorativeIcon>
      <PopupTitle variant="body" weight="bold" center>
        Turn on notifications?
      </PopupTitle>
      <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
        {moment ? PRIME_COPY[moment] : ''}
      </T>
      <PillButton label="Turn on" onPress={() => answer(true)} style={{ alignSelf: 'stretch', marginBottom: space.md }} />
      <LinkText label="Not now" tone="muted" onPress={() => answer(false)} />
    </PopupCard>
  );
}
