import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { color, space } from '@swift/ui';
import { IconChip, PillButton, PopupCard, PopupTitle, T } from '../../../kit';

/**
 * The prominent disclosure Google Play requires before ANY background-location
 * request [LAUNCH-3].
 *
 * Play's Location Permissions policy is specific about this and it is one of
 * the most commonly-rejected items on the store. The OS permission sheet does
 * NOT count — it is Android's words, not ours, and it does not say what Swift
 * does with the data. Before that sheet appears the app must state, in its own
 * UI: what is collected, that collection continues while the app is closed or
 * not in use, and what it is used for. The person must then affirmatively
 * accept. A purpose string in the manifest does not satisfy this, and neither
 * does explaining afterwards.
 *
 * Swift shipped without it: tapping GO went straight to the OS sheet.
 *
 * THE COPY IS THE FEATURE. Two rules govern it:
 *
 * 1. It says "even when the app is closed or not in use" — Play's reviewers
 *    look for that specific idea, and it happens to be the literal truth about
 *    what the background task does.
 * 2. It does not oversell. Declining is a real, working choice: the earner
 *    still goes online, Swift just tracks while the app is open. Copy that
 *    implied refusal breaks the app would be both a lie and a dark pattern,
 *    and the honest version is what a driver deciding at 6am deserves.
 *
 * Declining resolves false and the OS prompt is never raised — no prompt
 * without consent, which is the half of the policy that actually protects
 * someone.
 */
export function useBackgroundLocationDisclosure() {
  const [visible, setVisible] = useState(false);
  // The pending resolver for the promise `disclose()` handed its caller. A ref
  // rather than state: settling it must not depend on a re-render landing.
  const pending = useRef<((accepted: boolean) => void) | null>(null);

  const settle = useCallback((accepted: boolean) => {
    setVisible(false);
    const resolve = pending.current;
    pending.current = null;
    resolve?.(accepted);
  }, []);

  const disclose = useCallback(() => {
    // A second call while one is open would strand the first caller's promise
    // forever, and a stranded promise here means the GO button spins for good.
    if (pending.current) {
      const stranded = pending.current;
      pending.current = null;
      stranded(false);
    }
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setVisible(true);
    });
  }, []);

  const disclosure = (
    // Dismissing by backdrop is a DECLINE, never an accept. Consent has to be
    // an act; the absence of one is a no.
    <PopupCard visible={visible} onClose={() => settle(false)}>
      <IconChip icon="map-pin" size={56} />
      <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
        Swift needs your location in the background
      </PopupTitle>

      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        While you are online, Swift collects your location even when the app is
        closed or not in use — so jobs can reach you, and so the customer can
        watch their delivery move.
      </T>

      <View style={{ alignSelf: 'stretch', gap: space.sm, marginTop: space.lg }}>
        <DisclosureLine text="Where you are, while you are online" />
        <DisclosureLine text="Sent only to Swift — never sold, never shared with advertisers" />
        <DisclosureLine text="Stops the moment you go offline" />
      </View>

      <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
        <PillButton label="Allow background location" size="md" onPress={() => settle(true)} />
        <PillButton
          label="Only while app is open"
          variant="soft"
          size="md"
          onPress={() => settle(false)}
        />
      </View>

      <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>
        You can go online either way. Without background access Swift tracks you
        only while the app is on screen.
      </T>
    </PopupCard>
  );

  return { disclosure, disclose };
}

function DisclosureLine({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: color.brand[600],
          marginTop: 8,
        }}
      />
      <T variant="label" tone="muted" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}
