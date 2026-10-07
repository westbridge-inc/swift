/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { color, radius, space } from '@swift/ui';
import { Card, ConfirmDialog, IconChip, PillButton, StatePill, T } from '../../../kit';
import { cardFeeApi } from '../../../services/api';
import { getAuthSessionSnapshot, useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useStepUp } from '../../../hooks/useStepUp';
import { isStepUpDismissed } from '../../../lib/stepUp';
import {
  CARD_IDLE, CARD_RETURN, CARD_TEST_LABEL, CardCheckoutSession, cardExpiry, cardLabel, cardMoney, cardPageReopenable, cardPaymentPending,
  cardRemovedWords, cardSessionTone, cardSessionWords, cardSpoken, type CardCheckoutView, type CardFamily, type CardPointer, type LiveCard,
} from '../../../lib/cardFee';

/** The last card session each partner context started, for this app run only. Never a page address. */
const lastSession = new Map<string, CardPointer>();
/** One partner context: the signed-in principal and session, the fee family and, for a store, the store. */
export function cardContextKey(principal: string | undefined, generation: number | undefined, family: CardFamily, storeId: string | null | undefined): string {
  return `${principal ?? '-'}:${generation ?? '-'}:${family}:${family === 'vendor' ? storeId ?? '-' : '-'}`;
}
/** A card session this context started is still remembered (shown even if cards were switched off since). */
export const hasCardSession = (context: string) => lastSession.has(context);

/**
 * "Pay by card" on the one weekly-fee page (CARD-CHECKOUT-API). Shown only when the server
 * says CARD is live. The card number is typed on the bank's hosted page, opened in the
 * in-app browser sheet; this screen has no card field of any kind. Every state it shows
 * is the server's read of the session, never the browser's result.
 */
export function CardPaySection({ family, card, contextPending, otherPaymentPending, refresh, onPaymentPending }: {
  family: CardFamily;
  card?: LiveCard;
  contextPending: boolean;
  /** An MMG payment is being confirmed: no second payment is offered. */
  otherPaymentPending: boolean;
  refresh: () => unknown;
  onPaymentPending: (_pending: boolean) => void;
}) {
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const [view, setView] = useState<CardCheckoutView>(CARD_IDLE);
  const [consent, setConsent] = useState(false);
  const [removing, setRemoving] = useState<'ask' | 'busy' | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removeNotice, setRemoveNotice] = useState('');
  const stepUp = useStepUp();
  const refreshRef = React.useRef(refresh); refreshRef.current = refresh;
  // The parent hears "a card payment may be taking money" in the same render as the words, never a frame later.
  const pendingRef = React.useRef(onPaymentPending); pendingRef.current = onPaymentPending;
  const context = cardContextKey(principal, generation, family, storeId);
  const client = useMemo(() => {
    const owner = getAuthSessionSnapshot();
    return cardFeeApi(family, owner?.userId === principal && owner?.generation === generation ? owner : null, storeId);
  }, [family, storeId, principal, generation]);
  const session = useMemo(() => new CardCheckoutSession({
    start: client.start,
    read: client.read,
    open: (url) => WebBrowser.openAuthSessionAsync(url, CARD_RETURN),
    refresh: () => { void refreshRef.current(); },
    save: (pointer) => { if (pointer) lastSession.set(context, pointer); else lastSession.delete(context); },
    load: () => lastSession.get(context) ?? null,
  }, () => Crypto.randomUUID(), (v) => {
    setView(v);
    pendingRef.current(cardPaymentPending(v.session) || v.busy === 'PAY_NOW');
  }, (e) => {
    const failure = e as { response?: { status?: number; data?: { error?: { code?: string } } } };
    return { status: failure.response?.status, code: failure.response?.data?.error?.code };
  }), [client, context]);
  useEffect(() => { session.activate(); if (!contextPending) session.resume(); return () => session.dispose(); }, [session, contextPending]);
  useFocusEffect(useCallback(() => { if (!contextPending) session.focus(); }, [session, contextPending]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active' && !contextPending) session.focus(); });
    return () => listener.remove();
  }, [session, contextPending]);
  const pending = cardPaymentPending(view.session) || view.busy === 'PAY_NOW';
  useEffect(() => { onPaymentPending(pending); }, [pending, onPaymentPending]);

  const live = card && !view.off && !contextPending ? card : undefined;
  // Off, and nothing of ours in flight: the card choice does not exist here.
  if (!live && !view.session && !view.error && !removeNotice) return null;
  const onFile = live?.cardOnFile ?? null;
  const testLabel = live?.testMode ? live.testModeLabel : view.session?.testMode ? view.session.testModeLabel ?? CARD_TEST_LABEL : '';
  const enrolling = view.session?.purpose === 'ENROLL' && view.session.status === 'OPEN';
  const canPay = !!live && !pending && !otherPaymentPending && !view.busy;
  const remove = async () => {
    if (!onFile) return;
    setRemoving('busy'); setRemoveError(''); setRemoveNotice('');
    try {
      const answer = await stepUp.withStepUp(() => client.remove(onFile.id))();
      setRemoving(null);
      setRemoveNotice(cardRemovedWords(answer));
      void refreshRef.current();
    } catch (e) {
      setRemoving(null);
      if (!isStepUpDismissed(e)) setRemoveError("Couldn't remove the card. Try again.");
    }
  };
  return <Card testID="card-pay" style={{ gap: space.md }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <IconChip icon="credit-card" />
      <View style={{ flex: 1 }}>
        <T variant="heading" accessibilityRole="header">{live ? 'Pay by card (Visa / Mastercard)' : 'Card payment'}</T>
        {live ? <T variant="caption" tone="muted">You type your card on the bank&apos;s secure card page, inside Swift. Swift never sees or keeps your card number.</T> : null}
      </View>
    </View>
    {testLabel ? <StatePill label={testLabel} tone="warning" /> : null}
    {onFile ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.surface.subtle }}>
      <View style={{ flex: 1 }}>
        <T variant="label" weight="semibold" accessibilityLabel={cardSpoken(onFile)}>{cardLabel(onFile)}</T>
        <T variant="caption" tone="muted">{cardExpiry(onFile)} · Charged for your weekly fee</T>
      </View>
      <PillButton label="Remove card" variant="outline" size="md" loading={removing === 'busy'} onPress={() => setRemoving('ask')} />
    </View> : null}
    {removeError ? <T variant="caption" tone="error">{removeError}</T> : null}
    {removeNotice ? <T variant="body" accessibilityLiveRegion="polite">{removeNotice}</T> : null}
    {view.session ? <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: { success: color.soft.success, error: color.soft.danger, waiting: color.soft.warning, neutral: color.soft.info }[cardSessionTone(view.session)] }}>
      <T variant="body" weight="semibold" accessibilityLiveRegion="polite">{cardSessionWords(view.session, view.returned)}</T>
    </View> : null}
    {view.error ? <T variant="caption" tone="error" accessibilityLiveRegion="polite">{view.error}</T> : null}
    {live && view.returned && cardPageReopenable(view.session) ? <PillButton label="Continue on the card page" variant="soft" loading={!!view.busy} onPress={() => { void session.reopen(); }} /> : null}
    {canPay ? <PillButton label={`Pay ${cardMoney(live.payNow.amount, live.payNow.currencyCode)} by card`} variant="dark" onPress={() => { void session.start('PAY_NOW'); }} /> : null}
    {view.busy === 'PAY_NOW' ? <PillButton label="Opening the card page…" variant="dark" loading /> : null}
    {live?.addCard && !enrolling && !pending && !consent && !view.busy ? <PillButton label={onFile ? 'Change card' : 'Use a card for the weekly fee'} variant="outline" onPress={() => setConsent(true)} /> : null}
    {live?.addCard && (consent || view.consent) ? <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: color.brand[50] }}>
      <T variant="label" weight="semibold">Charge this card each week?</T>
      <T variant="caption">Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.</T>
      <PillButton label="Agree and add a card" loading={view.busy === 'ENROLL'} onPress={() => { setConsent(false); void session.start('ENROLL'); }} />
      <PillButton label="Not now" variant="soft" onPress={() => setConsent(false)} />
    </View> : null}
    <ConfirmDialog
      open={removing === 'ask'}
      title="Remove this card?"
      body={onFile ? `${cardLabel(onFile)} will not be charged again. Your weekly fee stays due until you pay it another way.` : undefined}
      confirmLabel="Remove card"
      destructive
      onConfirm={() => { void remove(); }}
      onClose={() => setRemoving(null)}
    />
    {stepUp.sheet}
  </Card>;
}
