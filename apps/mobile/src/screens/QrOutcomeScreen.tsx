/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { space } from '@swift/ui';
import { Header, PillButton, Screen, T } from '../kit';
import { retryQrDestination, type LinkDestination, type ResolveFailure } from '../services/deep-links';

export type QrOutcomeParams = { reason: ResolveFailure; destination: LinkDestination; requestId: number };

// Keep retired/unavailable/unknown wording aligned with web /qr/* pages.
// Only the collapsed verdict is displayed: never render server error text.
const copy: Record<ResolveFailure, { title: string; body: string }> = {
  replaced: {
    title: 'This QR code has been replaced',
    body: 'This printed code is no longer in use. Use the store’s current page or ask the business for its latest counter card.',
  },
  unavailable: {
    title: 'This store is not available from this code',
    body: 'This store isn’t taking orders right now. Nothing has been ordered or charged. Try again later or browse another store.',
  },
  'not-a-swift-code': {
    title: 'Swift could not read this counter code',
    body: 'Check that the whole QR code is in view and scan it again. If the result is the same, ask the business for a current link.',
  },
  offline: {
    title: 'Could not connect to this store',
    body: 'We could not check this code. Check your connection and try again. Nothing has been ordered or charged.',
  },
};

export function QrOutcomeScreen() {
  const { reason, destination, requestId } = useRoute().params as QrOutcomeParams;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { inFlight.current = false; setBusy(false); }, [requestId]);
  const retry = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await retryQrDestination(destination, requestId); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <Screen>
      <Header title="Store QR code" />
      <View style={{ flex: 1, justifyContent: 'center', padding: space.xl }}>
        <T variant="heading" center>{copy[reason].title}</T>
        <T variant="body" tone="muted" center style={{ marginTop: space.lg }}>{copy[reason].body}</T>
        {reason === 'offline' ? <PillButton label={busy ? 'Checking…' : 'Retry'} disabled={busy} onPress={() => void retry()} style={{ marginTop: space.xl }} /> : null}
        <T variant="caption" tone="muted" center style={{ marginTop: space.xl }}>powered by Swift</T>
      </View>
    </Screen>
  );
}
