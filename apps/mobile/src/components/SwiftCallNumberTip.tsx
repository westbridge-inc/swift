import React from 'react';
import { Pressable, View } from 'react-native';
import { space } from '@swift/ui';
import { T } from '../kit';
import { toast } from '../kit/toast';
import { useCallConfig } from '../hooks/useCallParty';
import { CALLER_LINE_WORDS, callerLine } from '../lib/callBridge';
import { copyText } from '../lib/clipboard';

/**
 * [O-1 · owner 24 Oct] "Save Swift's call number" · [CALL-RELAY-ON · owner 6 Nov] "so a call does not look
 * like a scam": Guyana networks show only a number for an incoming call (no caller name), so every screen
 * with "Call via Swift" says which number Swift calls from: "Swift calls you from <its number> (save it as
 * Swift)." The number is the server's (GET /calls/config), never typed into the app. Shown only while calls
 * go through Swift; nothing while the bridge is off (the launch state).
 *
 * "Copy number" uses React Native's own clipboard (lib/clipboard.ts, already in the store builds), so this
 * ships over the air. Saving straight to Contacts would need a native contacts module: not in this app, so
 * the person pastes it into a new contact. The number also stays selectable (press and hold).
 */
export function SwiftCallNumberTip() {
  const config = useCallConfig();
  const callerId = config?.enabled ? config.callerId : null;
  const line = callerLine(callerId);
  if (!callerId || !line) return null;
  const copy = () => {
    if (copyText(callerId)) toast.success(CALLER_LINE_WORDS.copied, CALLER_LINE_WORDS.copiedHow);
    else toast.show(CALLER_LINE_WORDS.copyFailed);
  };
  return (
    <View style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ flex: 1 }}>
        <T variant="label" tone="muted" selectable accessibilityRole="text">
          {line}
        </T>
      </View>
      <Pressable
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel={CALLER_LINE_WORDS.copyA11y}
        style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: space.xs }}
      >
        <T variant="label" weight="semibold" tone="deep">{CALLER_LINE_WORDS.copy}</T>
      </Pressable>
    </View>
  );
}
