/** @jsxImportSource react */
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, motion, radius, space, withAlpha } from '@swift/ui';
import { IconChip, LinkText, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { money } from '../../lib/money';
import {
  daysUntil,
  isBehind,
  isBillingStopped,
  isBlocked,
  shortDate,
  walletLine,
  weeklyFeeGyd,
  billingStoppedLine,
} from '../../lib/billing';

// ---------------------------------------------------------------------------
// THE FEE REMINDER BANNER
//
// One band across the top of the board: what is owed, when, and the way to
// clear it — nothing else. The rules it obeys:
//
//   · A warning owns its own colour. The ground is the amber blush, the rule is
//     an amber hairline, the amount is amber — and so is the CTA. Maroon is not
//     borrowed for this: the brand is not what is being escalated, and a maroon
//     button here would read as "the app wants something", not "the fee is due".
//   · Nothing turns red. Being due today is not an error, and a vendor mid-rush
//     must not be made to think their store just broke.
//   · It escalates by CONTRAST and by WHICH WORDS ARE PRESENT — "due today" is a
//     different sentence from "due by 26 Aug" — never by growing, shouting in
//     caps, or stacking punctuation.
//   · Every word is server truth. The amount is the payload's amountDueGyd and
//     appears only when there is one; the day is the payload's own deadline, so
//     "today" is printed only when the server's date IS today. With no deadline
//     the band says "due now" and names no day it cannot prove.
// ---------------------------------------------------------------------------

/** The banner's action. Amber, pill, 36 — deliberately not the kit's maroon
 *  PillButton (see the note above); deliberately not a bare link either, because
 *  this is the one thing on the band worth tapping. */
function AmberCta({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
      {({ pressed }) => (
        <View
          style={{
            height: 36,
            borderRadius: radius.full,
            paddingHorizontal: space.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.warning,
            opacity: pressed ? motion.opacity.pressed : 1,
          }}
        >
          <T variant="label" weight="semibold" style={{ color: color.white }}>
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** The two lines, derived from the server's deadline alone. A deadline already
 *  past is "due now" — never "due today", which would be a lie on the one screen
 *  that can least afford one. Both lines are kept short enough to survive a
 *  narrow phone beside the CTA: a truncated deadline is the same defect as a
 *  wrong one. Role-neutral wording, because a mover reads this band too. */
function dueWording(deadline?: string | null): { when: string; sub: string } {
  const days = daysUntil(deadline ?? null);
  if (days == null || days < 0) return { when: 'due now', sub: 'Pay to keep going' };
  if (days === 0) return { when: 'due today', sub: 'Pay any time today' };
  if (days === 1) return { when: 'due tomorrow', sub: 'Pay any time before then' };
  return { when: `due by ${shortDate(deadline)}`, sub: 'Pay any time before then' };
}

/**
 * The band itself. Self-guarding: it renders only for an account that is behind
 * (grace / past due) and still operating, so a surface can mount it
 * unconditionally at the top of a board and it will simply not be there on a
 * healthy week. A paused account is NOT this band — that state has its own,
 * fuller block below, because "pay to stay open" and "pay to reopen" are
 * different sentences.
 */
export function FeeReminderBanner({ sub, onPay, style }: { sub: any; onPay?: () => void; style?: ViewStyle }) {
  if (!sub || !isBehind(sub)) return null;
  const due = Number(sub.amountDueGyd ?? 0);
  const { when, sub: subLine } = dueWording(sub.gracePeriodEnd);
  // The amount leads when the server gave us one; otherwise the state leads and
  // no number is invented to fill the gap.
  const headline = due > 0 ? `${money(due)} ${when}` : `${when.charAt(0).toUpperCase()}${when.slice(1)}`;
  return (
    <View
      style={[
        {
          marginTop: space.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          minHeight: 56,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: withAlpha(color.warning, 0.35),
          backgroundColor: color.soft.warning,
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
        },
        style,
      ]}
    >
      {/* Sits on the FIRST line, not centred against both — the mark belongs to
          the amount, and the sub-line reads as a note under it. */}
      <Feather name="alert-triangle" size={18} color={color.warning} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <T variant="numM" tone="warning" numberOfLines={1}>
          {headline}
        </T>
        <T variant="caption" tone="muted" numberOfLines={1}>
          {subLine}
        </T>
      </View>
      {onPay ? <AmberCta label="Pay now" onPress={onPay} /> : null}
    </View>
  );
}

/** In-place status and reminders link into the shared weekly-fee checkout.
 * Payment methods and confirmation are rendered only on that screen. */
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

  if (isBlocked(sub)) {
    return <View style={[{ marginTop: space.md }, style]}>
      <T variant="body" weight="semibold">Your account is suspended</T>
      <T variant="caption">{due > 0 ? `Weekly fee due: ${money(due)}.` : 'Your weekly fee needs attention.'} Access updates when payment is credited.</T>
      {onPay ? <PillButton label="Weekly fee" onPress={onPay} /> : null}
    </View>;
  }

  // Grace / PAST_DUE (still operating) — the reminder band. Same handler as
  // before (`onPay` still opens the How-to-pay surface); it is now the band's
  // amber CTA instead of a link buried under two lines of copy.
  if (isBehind(sub)) return <FeeReminderBanner sub={sub} onPay={onPay} style={style} />;

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

  // The dedicated Weekly fee row remains the way into a healthy account.
  return null;
}

// ---------------------------------------------------------------------------
// E12 — STOP / RESUME WEEKLY BILLING
//
// The partner's self-serve door out of the recurring fee. "Stop weekly
// billing" sits behind a confirm that names the exact consequence: the plan
// stays active until the period end the server sent, and after that the store
// / driver / rider stops receiving work. While stopped the surface says so and
// offers Resume. Everything here reads server truth (`autoRenew`,
// `currentPeriodEnd`, `status`). Once the paid period is over the plan is
// PAUSED and Resume restarts it (this week billed like any renewal). A
// CANCELLED (closed) or CHURNED account hides the control — neither door would
// be honest, and the server refuses both.
// ---------------------------------------------------------------------------

export function BillingStopControl({
  sub,
  who,
  onStop,
  onResume,
  pending,
}: {
  sub: any;
  who: 'store' | 'driver' | 'rider';
  onStop: () => void;
  onResume: () => void;
  pending?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  if (!sub) return null;
  const status = String(sub.status ?? '').toUpperCase();
  if (status === 'CANCELLED' || status === 'CHURNED') return null;
  const stopped = isBillingStopped(sub);
  const blocked = isBlocked(sub);
  const periodEnd = shortDate(sub?.currentPeriodEnd);
  const untilLine = billingStoppedLine(sub, who);
  const confirmBody = blocked
    ? `Your ${who} is already paused. Stopping means no more weekly fees will be charged — what you owe still stands until you pay it. You can resume billing anytime.`
    : `Your ${who} keeps working until ${periodEnd ?? 'the end of the current period'}. After that, the ${who} stops receiving work and no more weekly fees are charged. You can resume billing anytime.`;

  return (
    <>
      {stopped ? (
        <View
          style={{
            marginTop: space.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: withAlpha(color.brand[500], 0.25),
            backgroundColor: color.surface.base,
            padding: space.lg,
          }}
        >
          <Feather name="pause-circle" size={18} color={color.brand[500]} />
          <View style={{ flex: 1 }}>
            <T variant="label" weight="semibold">
              Weekly billing stopped
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {untilLine}
            </T>
          </View>
          <PillButton label="Resume" size="md" variant="soft" loading={pending} onPress={onResume} />
        </View>
      ) : (
        <PillButton
          label="Stop weekly billing"
          variant="outline"
          size="md"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          onPress={() => setConfirmOpen(true)}
        />
      )}
      <PopupCard visible={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <IconChip icon="pause-circle" size={56} tone="brand" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Stop weekly billing?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {confirmBody}
        </T>
        <PillButton
          label="Stop billing"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={pending}
          onPress={() => {
            setConfirmOpen(false);
            onStop();
          }}
        />
        <PillButton
          label="Keep billing"
          variant="soft"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          onPress={() => setConfirmOpen(false)}
        />
      </PopupCard>
    </>
  );
}
