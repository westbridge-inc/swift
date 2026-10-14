/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef } from 'react';
import { Modal, View } from 'react-native';
import { color, space } from '@swift/ui';
import { PillButton, T } from '../../../kit';
import { cardMainFrameLeft, cardPageDecision, isCardReturnPage } from '../../../lib/cardPage';
import type { CardWebView } from '../../../lib/cardWebView';

/** How often the open sheet asks the server whether the card page is still open. */
export const CARD_SHEET_WATCH_MS = 4_000;

/**
 * The bank's card page INSIDE Swift: Swift's own server page (which frames the bank's
 * secure card form and its 3-D Secure check) in a full-screen sheet. The card is typed
 * only in the bank's form; this sheet has no field, no script of its own and no message
 * channel into the page (no onMessage, nothing injected), so nothing in the app can read
 * the card. Nothing is cached or kept after the sheet closes (incognito, no cache).
 *
 * The sheet closes when the partner taps "Back to the Swift app" (the return link), when
 * the server's return page reaches the main frame, when the main frame would leave Swift
 * and the card provider, when the partner taps Close, or when the server says the card
 * page is no longer open. Closing never decides anything: the weekly-fee page then asks
 * the server what happened, as it does after the in-app browser.
 */
export function CardPageSheet({ url, apiOrigin, WebView, watch, onDone }: {
  url: string;
  /** The API origin this app talks to: the only Swift origin the sheet shows. */
  apiOrigin: string;
  WebView: CardWebView;
  /** The server's read: true while the card session is still open. */
  watch?: () => Promise<boolean>;
  onDone: () => void;
}) {
  const done = useRef(false);
  const doneRef = useRef(onDone); doneRef.current = onDone;
  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    doneRef.current();
  }, []);
  useEffect(() => {
    if (!watch) return undefined;
    let stopped = false;
    const timer = setInterval(() => {
      watch().then((open) => { if (!stopped && !open) finish(); }, () => { /* Unreadable: the page stays; Close is always there. */ });
    }, CARD_SHEET_WATCH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [watch, finish]);

  // Android back (onRequestClose) and an iOS swipe-down of the page sheet (onDismiss) both close it.
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={finish} onDismiss={finish}>
    <View testID="card-page-sheet" style={{ flex: 1, backgroundColor: color.surface.base }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}>
        <View style={{ flex: 1 }}>
          <T variant="label" weight="semibold" accessibilityRole="header">Secure card page</T>
          <T variant="caption" tone="muted">Your bank&apos;s form. Swift never sees your card number.</T>
        </View>
        <PillButton label="Close" variant="soft" size="md" onPress={finish} />
      </View>
      <WebView
        source={{ uri: url }}
        style={{ flex: 1 }}
        // Every navigation, of every scheme, is decided below: nothing is handed to another app.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(request) => {
          const decision = cardPageDecision(request, apiOrigin);
          if (decision === 'return') finish();
          return decision === 'allow';
        }}
        onLoadStart={(event) => { if (cardMainFrameLeft(event.nativeEvent.url, apiOrigin)) finish(); }}
        onLoadEnd={(event) => { if (isCardReturnPage(event.nativeEvent.url, apiOrigin)) finish(); }}
        incognito
        cacheEnabled={false}
        cacheMode="LOAD_NO_CACHE"
        sharedCookiesEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        allowsLinkPreview={false}
        allowsBackForwardNavigationGestures={false}
        dataDetectorTypes="none"
        webviewDebuggingEnabled={false}
      />
    </View>
  </Modal>;
}
