/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { Card, ErrorState, InfoRow, LinkText, LoadingBlock, PillButton, T } from '../../kit';
import { money } from '../../lib/money';
import { copyText } from '../../lib/clipboard';
import { isBehind, isBlocked, shortDate, walletLine, weeklyFeeGyd, weeksCovered } from '../../lib/billing';

// ---------------------------------------------------------------------------
// Billing surfaces (TOLLGATE D) — the payer-facing half of the SAN + agent-cash
// rail the API already ships. Everything rendered here is server truth spread
// into GET /rider|/driver|/vendor/subscription (sanDisplay + payInfo): the
// Swift Number, the weekly fee, the parked wallet balance, the amount due, the
// step-by-step agent-cash instructions and the channel-honest activation copy.
// No copy claims anything the backend doesn't do — suspension is honest, and
// "resumes" leans on the payload's own `activationCopy` (real channel latency).
// ---------------------------------------------------------------------------

/** Copy-the-number affordance — flips to "Copied" briefly on success. The raw
 *  10-digit SAN is copied (what an agent terminal / MMG field wants; every
 *  server consumer strips formatting anyway). A no-op copy leaves the button
 *  as-is — the number is on screen and selectable. */
function CopyButton({ san }: { san: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onCopy = () => {
    if (!copyText(san)) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  return (
    <PillButton
      label={copied ? 'Copied' : 'Copy number'}
      icon={copied ? 'check' : 'copy'}
      variant="soft"
      size="md"
      onPress={onCopy}
    />
  );
}

/** The Swift Number as the hero — large, tabular, read-aloud friendly. */
function SanHero({ sub }: { sub: any }) {
  const san = String(sub?.san ?? '');
  const formatted = String(sub?.sanFormatted ?? san);
  return (
    <Card style={{ alignItems: 'center' }}>
      <T variant="micro" tone="muted">
        YOUR SWIFT NUMBER
      </T>
      <T variant="displayXl" center selectable style={{ marginTop: space.sm }}>
        {formatted}
      </T>
      <T variant="caption" tone="muted" center style={{ marginTop: space.sm, maxWidth: 300 }}>
        Read this out at any MMG agent to pay your weekly fee. It never changes.
      </T>
      {san ? (
        <View style={{ marginTop: space.lg, alignSelf: 'stretch' }}>
          <CopyButton san={san} />
        </View>
      ) : null}
    </Card>
  );
}

/** Weekly fee · wallet balance · amount due — receipt-grade rows. */
function AmountRows({ sub }: { sub: any }) {
  const weekly = weeklyFeeGyd(sub);
  const balance = Number(sub?.walletBalanceGyd ?? 0);
  const due = Number(sub?.amountDueGyd ?? 0);
  const weeks = weeksCovered(balance, weekly);
  const usdLine: string | undefined = sub?.usdDisplay?.line;
  return (
    <Card style={{ marginTop: space.md }}>
      <InfoRow label="Weekly fee" value={`${money(weekly)}/week`} />
      {balance > 0 ? <InfoRow label="In your wallet" value={money(balance)} /> : null}
      <InfoRow label="Due now" value={money(due)} strong />
      {balance > 0 && weeks >= 1 ? (
        <T variant="caption" tone="success" style={{ marginTop: space.xs }}>
          Covers {weeks} {weeks === 1 ? 'week' : 'weeks'} at this fee — nothing to do until then.
        </T>
      ) : null}
      {usdLine ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          {usdLine}
        </T>
      ) : null}
    </Card>
  );
}

/** Numbered agent-cash steps (payload `payCashSteps`). Plain rows so it nests
 *  in either a Card (screen) or a status block. */
function PayStepsList({ steps, style }: { steps: string[]; style?: ViewStyle }) {
  if (!steps.length) return null;
  return (
    <View style={style}>
      {steps.map((step, i) => (
        <View
          key={step}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginTop: i === 0 ? 0 : space.md }}
        >
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: radius.full,
              backgroundColor: color.brand[50],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <T variant="label" weight="bold" tone="deep">
              {String(i + 1)}
            </T>
          </View>
          <T variant="label" style={{ flex: 1, marginTop: 3 }}>
            {step}
          </T>
        </View>
      ))}
    </View>
  );
}

/** Top-of-screen honest strip on the My Swift Number screen — status context
 *  only (the SAN + steps are the screen itself, so it never repeats them). */
function StatusStrip({ sub }: { sub: any }) {
  const due = Number(sub?.amountDueGyd ?? 0);
  if (isBlocked(sub)) {
    return (
      <View
        style={{
          flexDirection: 'row',
          gap: space.md,
          borderRadius: radius.lg,
          backgroundColor: color.soft.danger,
          padding: space.lg,
          marginBottom: space.md,
        }}
      >
        <Feather name="alert-circle" size={18} color={color.error} style={{ marginTop: 1 }} />
        <View style={{ flex: 1 }}>
          <T variant="label" weight="bold" tone="error">
            Your account is paused
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            Pay {money(due)} below to switch back on.{sub?.activationCopy ? ` ${sub.activationCopy}` : ''}
          </T>
        </View>
      </View>
    );
  }
  if (isBehind(sub)) {
    const by = shortDate(sub?.gracePeriodEnd);
    return (
      <View
        style={{
          flexDirection: 'row',
          gap: space.md,
          borderRadius: radius.lg,
          backgroundColor: color.soft.warning,
          padding: space.lg,
          marginBottom: space.md,
        }}
      >
        <Feather name="alert-triangle" size={18} color={color.warning} style={{ marginTop: 1 }} />
        <View style={{ flex: 1 }}>
          <T variant="label" weight="bold" tone="warning">
            Fee due{by ? ` by ${by}` : ''}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            Pay {money(due)} below to keep going without a break.
          </T>
        </View>
      </View>
    );
  }
  return null;
}

/**
 * The full "My Swift Number" screen body (no header — the mover/vendor wrappers
 * supply their own). SAN hero + copy, amounts, agent-cash steps, and the
 * channel-honest activation line, with a loud honest strip on top when the
 * account is behind or paused.
 */
export function SwiftNumberView({
  sub,
  loading,
  error,
  onRetry,
}: {
  sub: any;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  if (loading) return <LoadingBlock />;
  if (error || !sub) {
    return (
      <ErrorState
        onRetry={onRetry}
        message="We couldn't load your Swift Number. Check your connection and try again."
      />
    );
  }
  const steps: string[] = Array.isArray(sub.payCashSteps) ? sub.payCashSteps : [];
  const activation: string | undefined = sub.activationCopy;
  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}
      showsVerticalScrollIndicator={false}
    >
      <StatusStrip sub={sub} />
      <SanHero sub={sub} />
      <AmountRows sub={sub} />
      {steps.length ? (
        <Card style={{ marginTop: space.md }}>
          <T variant="body" weight="semibold" style={{ marginBottom: space.md }}>
            How to pay
          </T>
          <PayStepsList steps={steps} />
        </Card>
      ) : null}
      {activation ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg, paddingHorizontal: space.xs }}>
          <Feather name="info" size={14} color={color.text.muted} style={{ marginTop: 2 }} />
          <T variant="caption" tone="muted" style={{ flex: 1 }}>
            {activation}
          </T>
        </View>
      ) : null}
      <T variant="caption" tone="muted" center style={{ marginTop: space.lg }}>
        The weekly fee is Swift&apos;s only charge — you keep 100% of everything you earn.
      </T>
    </ScrollView>
  );
}

/**
 * The in-place billing status block for the earner/vendor surfaces — wallet
 * balance when banked, the amount due when behind, and a prominent (in-card,
 * non-dismissable) block when paused. Offers a "How to pay" affordance into the
 * My Swift Number screen via `onPay`. `compact` drops the standalone healthy-
 * state affordances (for surfaces that already carry a dedicated "My Swift
 * Number" row, so the link isn't shown twice). Renders nothing when there's a
 * healthy account, nothing banked, and nothing to offer.
 */
export function BillingStatusBlock({
  sub,
  onPay,
  compact,
  style,
}: {
  sub: any;
  onPay?: () => void;
  compact?: boolean;
  style?: ViewStyle;
}) {
  if (!sub) return null;
  const due = Number(sub.amountDueGyd ?? 0);

  // SUSPENDED / CHURNED — paused. The honest, self-sufficient block: SAN +
  // steps + the payload's channel-true activation copy. Reinstatement is
  // instant server-side, so "the moment you pay" is true up to channel latency.
  if (isBlocked(sub)) {
    const san = String(sub.san ?? '');
    const formatted = String(sub.sanFormatted ?? san);
    const steps: string[] = Array.isArray(sub.payCashSteps) ? sub.payCashSteps : [];
    return (
      <View
        style={[
          {
            marginTop: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: withAlpha(color.error, 0.3),
            backgroundColor: color.soft.danger,
            padding: space.lg,
          },
          style,
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Feather name="alert-circle" size={16} color={color.error} />
          <T variant="body" weight="semibold" tone="error" style={{ flex: 1 }}>
            Your account is paused
          </T>
        </View>
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Pay the weekly fee and you&apos;re back on.{sub.activationCopy ? ` ${sub.activationCopy}` : ''}
        </T>
        {formatted ? (
          <View
            style={{
              marginTop: space.md,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: color.surface.base,
              alignItems: 'center',
            }}
          >
            <T variant="micro" tone="muted">
              YOUR SWIFT NUMBER
            </T>
            <T variant="numL" center selectable style={{ marginTop: 2 }}>
              {formatted}
            </T>
            {due > 0 ? (
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                Due now: {money(due)}
              </T>
            ) : null}
          </View>
        ) : null}
        <PayStepsList steps={steps} style={{ marginTop: space.md }} />
        {onPay ? (
          <PillButton label="How to pay" size="md" style={{ marginTop: space.md }} onPress={onPay} />
        ) : null}
      </View>
    );
  }

  // Grace / PAST_DUE (still operating) — the softer amber nudge.
  if (isBehind(sub)) {
    const by = shortDate(sub.gracePeriodEnd);
    return (
      <View
        style={[
          { marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.soft.warning, padding: space.lg },
          style,
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Feather name="alert-triangle" size={16} color={color.warning} />
          <T variant="label" weight="bold" tone="warning" style={{ flex: 1 }}>
            Fee due{by ? ` by ${by}` : ''}
            {due > 0 ? ` · ${money(due)}` : ''}
          </T>
        </View>
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Pay before then to keep going without a break.
        </T>
        {onPay ? (
          <View style={{ marginTop: space.sm }}>
            <LinkText label="How to pay" onPress={onPay} />
          </View>
        ) : null}
      </View>
    );
  }

  // Healthy — surface a parked wallet balance as reassurance (covers N weeks).
  const wallet = walletLine(Number(sub.walletBalanceGyd ?? 0), weeklyFeeGyd(sub));
  if (wallet) {
    return (
      <View style={[{ marginTop: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }, style]}>
        <Feather name="check-circle" size={14} color={color.success} />
        <T variant="caption" weight="semibold" tone="success" style={{ flex: 1 }}>
          {wallet}
        </T>
        {onPay && !compact ? <LinkText label="Top up" onPress={onPay} /> : null}
      </View>
    );
  }

  // Healthy account, nothing banked — say nothing here. The dedicated "My Swift
  // Number" row (account surfaces) is the way in; nothing needs paying now.
  return null;
}
