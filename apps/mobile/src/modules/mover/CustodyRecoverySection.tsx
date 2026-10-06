/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { space, radius } from '@swift/ui';
import { DecorativeIcon, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { toast } from '../../kit/toast';
import { haptic } from '../../lib/haptics';
import { moneyIn } from '../../lib/money';
import { RIDER_PROBLEM_REASONS, type RiderProblemReason } from '../../lib/custodyRecovery';
// Through the hooks barrel, like every screen, so a screen test's barrel mock covers it.
import { useHolderCase, useReportProblem } from '../../hooks';
import { dk, withAlpha } from './surface';

/**
 * [AF-MOB-006] AFTER PICKUP, A PROBLEM IS A CASE, NOT A PHONE CALL.
 *
 * Before pickup the rider can hand a job back. After it they hold someone's
 * goods (and, on cash, the money they fronted the store), so the only honest
 * door is a report: Swift support owns the case and decides hold, return or
 * relay, and this card shows what was decided — including the handoff code the
 * rider shows a relay rider. Two steps, never one tap.
 */
export function CustodyRecoverySection({ orderId, inCustody }: { orderId: string; inCustody: boolean }) {
  const holder = useHolderCase(orderId, inCustody);
  const report = useReportProblem();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RiderProblemReason | null>(null);
  // Only an OPEN case is shown: once it resolves (a handoff, a return) the
  // job itself says what happens next, and a new incident is a new report.
  const kase = holder.data?.open ? holder.data : null;

  const submit = () => {
    if (!reason) return;
    report.mutate(
      { orderId, reason },
      {
        onSuccess: () => {
          haptic.success();
          setOpen(false);
          setReason(null);
          toast.show('Problem reported', 'Swift support has the case. Keep the order safe — the next step will show here.');
        },
        onError: (e: any) => toast.show(e?.response?.data?.error?.message ?? "Couldn't report the problem — check your connection and try again."),
      },
    );
  };

  return (
    <>
      {kase ? (
        <View
          accessibilityLabel="Delivery recovery"
          style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: dk.accentBorder, backgroundColor: withAlpha(dk.accent, 0.08), padding: space.md, marginTop: space.md }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Feather name="life-buoy" size={15} color={dk.accent} />
            <T variant="caption" weight="bold" style={{ color: dk.accent, letterSpacing: 1 }}>
              RECOVERY CASE OPEN
            </T>
          </View>
          <T variant="label" style={{ color: dk.text, marginTop: space.sm }}>{kase.instruction}</T>
          {kase.codeExpired ? (
            <View style={{ marginTop: space.md, alignItems: 'center' }}>
              <T variant="label" weight="bold" style={{ color: dk.text }}>Handoff code expired</T>
              <T variant="caption" style={{ color: dk.muted, marginTop: 2, textAlign: 'center' }}>
                Don’t hand the order over. Swift support is arranging the handoff again.
              </T>
            </View>
          ) : kase.transferCode ? (
            <View style={{ marginTop: space.md, alignItems: 'center' }}>
              <T variant="caption" style={{ color: dk.muted }}>
                {kase.relayFirstName ? `Handoff code for ${kase.relayFirstName}` : 'Handoff code'}
              </T>
              <T
                variant="display"
                weight="bold"
                accessibilityLabel={`Handoff code ${kase.transferCode.split('').join(' ')}`}
                style={{ color: dk.text, letterSpacing: 6, marginTop: 2 }}
              >
                {kase.transferCode}
              </T>
              {kase.floatToCollect > 0 ? (
                <T variant="caption" style={{ color: dk.muted, marginTop: 2 }}>
                  Collect {moneyIn(kase.floatToCollect)} from them first
                </T>
              ) : null}
            </View>
          ) : null}
          <T variant="caption" style={{ color: dk.muted, marginTop: space.sm }}>
            {kase.ownedBySupport ? 'A Swift operator owns this case.' : 'Swift support has been paged and will take this case.'}
          </T>
        </View>
      ) : inCustody ? (
        <PillButton
          label="Report a problem with this delivery"
          variant="soft"
          icon="life-buoy"
          style={{ marginTop: space.sm }}
          disabled={report.isPending || holder.isLoading}
          onPress={() => setOpen(true)}
        />
      ) : null}

      <PopupCard visible={open} onClose={() => { if (!report.isPending) { setOpen(false); setReason(null); } }}>
        <PopupTitle variant="title" center>What went wrong?</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          You already have the order, so it can’t be handed back. Swift support takes the case over and tells you whether to hold it, return it or hand it to another rider.
        </T>
        <View style={{ marginTop: space.lg, gap: space.xs }}>
          {RIDER_PROBLEM_REASONS.map((r) => (
            <Pressable
              key={r.code}
              accessibilityRole="radio"
              accessibilityState={{ selected: reason === r.code }}
              onPress={() => setReason(r.code)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, minHeight: 48 }}
            >
              <DecorativeIcon>
                <Feather name={reason === r.code ? 'check-circle' : 'circle'} size={18} color={reason === r.code ? dk.accent : dk.muted} />
              </DecorativeIcon>
              <T variant="body" style={{ color: dk.text }}>{r.label}</T>
            </Pressable>
          ))}
        </View>
        <PillButton
          label="Report to Swift support"
          style={{ alignSelf: 'stretch', marginTop: space.lg }}
          disabled={!reason || report.isPending}
          onPress={submit}
        />
      </PopupCard>
    </>
  );
}
