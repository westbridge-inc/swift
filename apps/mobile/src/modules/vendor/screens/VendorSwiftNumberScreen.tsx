/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import {
  Card,
  ErrorState,
  IconChip,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
} from '../../../kit';
import { GUTTER } from '../shared';
import { CopyButton } from '../../../components/billing/BillingSurfaces';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { money } from '../../../lib/money';
import { payScreenState, type PayBandTone } from '../../../lib/billing';

/** The tone of the state band — one 8px dot and one coloured word, never a
 *  filled tint card [Swift Pay §1a, "Colour budget"]. Viridian for covered,
 *  burnt amber for owed, ink for paused. Nothing on this screen turns red:
 *  being behind on a bill is not an error state, it is a Tuesday. */
const PAY_BAND_INK: Record<PayBandTone, string> = {
  covered: color.success,
  owed: color.warning,
  paused: color.text.primary,
};

export function VendorSwiftNumberScreen({ navigation }: any) {
  const q = useVendorSubscription();
  const insets = useSafeAreaInsets();
  const [aboutOpen, setAboutOpen] = useState(false);
  const sub: any = q.data;
  const swiftNumber = String(sub?.sanFormatted ?? sub?.san ?? '');
  const steps: string[] = Array.isArray(sub?.payCashSteps) ? sub.payCashSteps : [];
  const state = payScreenState(sub);
  const bandInk = PAY_BAND_INK[state.tone];
  const activationCopy = typeof sub?.activationCopy === 'string' ? sub.activationCopy : '';

  // The two standing facts about the fee. Declared once and rendered in two
  // places (the header's (i) sheet and the page footer) so the sheet can never
  // drift from the fine print it explains.
  const FEE_ONLY_CHARGE = 'The weekly fee is Swift’s only charge — you keep everything you earn.';
  const HOLD_NOTE = 'Confirmation clears a billing hold. Any separate verification hold remains until its own issue is fixed.';

  return (
    // `bleed` so the maroon runs under the status bar. A paper strip above a
    // maroon bar reads as a broken banner, not as chrome.
    <Screen bleed>
      {/* THE ONE MAROON HEADER. Every other customer/vendor surface is paper —
          this screen is the deliberate exception: the fee is Swift's own
          business with the vendor, so Swift's colour signs it. Built inline
          rather than via SubHeader, which paints ink-on-paper only and has no
          tone/right-glyph props; it is shared by four other screens, so
          widening it is not this file's change to make. */}
      <StatusBar barStyle="light-content" />
      <View style={{ backgroundColor: color.brand[500], paddingTop: insets.top }}>
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: GUTTER }}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            {({ pressed }) => (
              <View style={{ width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="chevron-left" size={24} color={color.text.onBrand} />
              </View>
            )}
          </Pressable>
          <T
            variant="heading"
            tone="onBrand"
            numberOfLines={1}
            accessibilityRole="header"
            style={{ flex: 1, textAlign: 'center', paddingHorizontal: space.md }}
          >
            Weekly fee
          </T>
          <Pressable
            onPress={() => setAboutOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="About the weekly fee"
          >
            {({ pressed }) => (
              <View style={{ width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="info" size={20} color={color.text.onBrand} />
              </View>
            )}
          </Pressable>
        </View>
      </View>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError && !sub ? (
        <ErrorState message="We couldn't load your Swift Number. Check your connection and try again." onRetry={() => q.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={color.brand[500]} />}
        >
          {q.isError ? (
            <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
              Showing the last loaded billing details — refresh did not complete.
            </T>
          ) : null}
          {/* THE AMOUNT, AS HERO. The most readable thing we can put on a cheap
              screen in sunlight — near-black ink on paper, not brand, not a
              tint card. A vendor checking whether they owe anything should need
              one glance, so nothing else on this screen competes with it. */}
          <View style={{ paddingTop: space['2xl'], paddingBottom: space.lg }}>
            <T variant="micro" tone="muted">
              {state.eyebrow}
            </T>
            <T variant="displayXl" style={{ marginTop: space.sm }}>
              {money(state.amountGyd)}
            </T>
            {state.covers ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {state.covers}
              </T>
            ) : null}
          </View>

          {/* THE BAND, in a soft neutral box — surface.sunken, NOT a brand tint:
              the box is a shelf for the state, and colour on this screen is
              spent only on the dot and the one word beside it. The four states
              differ only here; the rest of the screen never moves. */}
          <View
            style={{
              backgroundColor: color.surface.sunken,
              borderRadius: radius.lg,
              padding: space.lg,
              marginBottom: space.lg,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: bandInk }} />
              <T variant="body" weight="semibold" style={{ flex: 1, color: bandInk }}>
                {state.title}
              </T>
            </View>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {state.body}
            </T>
            {state.extra ? (
              // PINV-8, in the vendor's own words. Proven server-side by
              // api/src/__tests__/billing-suspension-retention.test.ts.
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {state.extra}
              </T>
            ) : null}
          </View>

          {/* DOOR 2 — the account number, and the steps that use it, in ONE
              card: they are a single act.

              Door 1 (card) is deliberately absent. It needs WiPay, and whether
              WiPay settles GYD at all is still an open question (PAY-1
              BLOCKER-1). The design slide shows a "Pay by card" button; adding
              it before that answer arrives would be the screen lying about a
              door that does not open, so there is exactly one door here.

              Copy-number IS here, and it should have been from the start — I
              told the builder it needed a native module the app doesn't ship,
              and that was wrong. `lib/clipboard.ts` already wraps the copy in a
              guarded require and REPORTS whether it happened, and the same
              button has been live on the rider's Swift Number screen for a
              while. Same number, same rail, so the vendor had strictly less. It
              is the shared component, not a second copy of it.

              The QR is still absent, for a narrower reason than I first gave:
              react-native-svg is a dependency and GET /vendor/qr does return an
              SVG — but that is the STOREFRONT code customers scan to order, not
              a payment code. Rendering it here would put the wrong QR on a money
              screen. It needs a SAN payload endpoint, and MMG-Q1 (can an agent
              terminal even scan one?) is still unanswered. */}
          <Card style={{ marginBottom: space.lg, borderWidth: 1, borderColor: color.border.subtle }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <IconChip icon="hash" size={44} />
              <View style={{ flex: 1 }}>
                <T variant="heading">Pay with account number</T>
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  MMG app, or cash at any agent
                </T>
              </View>
            </View>

            <T variant="displayXl" selectable style={{ marginTop: space.lg }}>
              {swiftNumber || '—'}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Give this to the agent. It never changes.
            </T>

            {/* Copies the RAW digits — an agent keys digits into a terminal. */}
            {sub?.san ? (
              <View style={{ marginTop: space.lg, alignSelf: 'flex-start' }}>
                <CopyButton san={String(sub.san)} />
              </View>
            ) : null}

            <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
              <T variant="heading">How to pay</T>
              {steps.length > 0 ? (
                <View style={{ marginTop: space.sm }}>
                  {steps.map((step, index) => (
                    <View key={step} style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                      <View
                        style={{
                          width: space['3xl'],
                          height: space['3xl'],
                          borderRadius: radius.full,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: color.brand[50],
                        }}
                      >
                        <T variant="label" weight="bold" tone="brand">
                          {index + 1}
                        </T>
                      </View>
                      <T variant="label" style={{ flex: 1 }}>
                        {step}
                      </T>
                    </View>
                  ))}
                </View>
              ) : (
                <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
                  Payment steps were not returned. Show your Swift Number to an MMG agent and confirm the amount before paying.
                </T>
              )}
            </View>
          </Card>

          {/* The design also shows a quiet "Receipts" link under this card. The
              vendor stack registers no receipts/billing-history route and the
              subscription payload carries no payment history, so the link is
              omitted rather than pointed at nothing. */}

          {/* The waiting state, said plainly. A vendor who has just handed cash
              to an agent is standing there wondering what to do next, and the
              honest answer is "nothing" — the rail is a push, we watch for it. */}
          <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
            {activationCopy ? `${activationCopy} ` : ''}There is nothing to type here — we watch for the payment and update this screen ourselves.
          </T>

          <T variant="caption" tone="muted" center>
            {FEE_ONLY_CHARGE}
          </T>

          <T variant="caption" tone="faint" center style={{ marginTop: space.sm }}>
            {HOLD_NOTE}
          </T>
        </ScrollView>
      )}

      {/* What the (i) in the header opens. Same two facts as the footer, said
          once in the place a vendor taps when they are asking "what IS this?". */}
      <PopupCard visible={aboutOpen} onClose={() => setAboutOpen(false)}>
        <IconChip icon="info" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          About the weekly fee
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {FEE_ONLY_CHARGE}
        </T>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          {HOLD_NOTE}
        </T>
        <PillButton
          label="Got it"
          variant="soft"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => setAboutOpen(false)}
        />
      </PopupCard>
    </Screen>
  );
}
