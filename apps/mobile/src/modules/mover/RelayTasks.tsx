/** @jsxImportSource react */
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { space } from '@swift/ui';
import { CodeInput, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { toast } from '../../kit/toast';
import { haptic } from '../../lib/haptics';
import { moneyIn } from '../../lib/money';
import { openExternal } from '../../lib/openExternal';
import { declineErrorMessage, isHandoffCode, relayErrorAction, type RelayTask } from '../../lib/custodyRecovery';
// Through the hooks barrel, like every screen, so a screen test's barrel mock covers it.
import { useDeclineRelay, useRelayTasks, useTransferCustody } from '../../hooks';
import { DCard, dk } from './surface';

/** One attempt key per opened handoff: a retry after a lost answer replays it. */
function newAttemptKey(caseId: string): string {
  return `custody-${caseId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * [AF-MOB-006] A RELAY RIDER'S HANDOFFS. Swift asked this rider to take an
 * order over from another rider who cannot finish it. Until they type the
 * code the holder shows them, the order is NOT theirs — no address, no
 * customer, no door. The card says where to meet and what cash to bring.
 */
export function RelayTasks({ enabled, onTakenOver }: { enabled: boolean; onTakenOver?: () => void }) {
  const tasks = useRelayTasks(enabled);
  const transfer = useTransferCustody();
  const decline = useDeclineRelay();
  const [active, setActive] = useState<RelayTask | null>(null);
  const [code, setCode] = useState('');
  const attempt = useRef<string | null>(null);
  const list = tasks.data ?? [];
  if (list.length === 0) return null;

  const openTask = (t: RelayTask) => {
    attempt.current = newAttemptKey(t.caseId);
    setCode('');
    setActive(t);
  };

  const submit = () => {
    if (!active || !isHandoffCode(code) || !attempt.current) return;
    transfer.mutate(
      { caseId: active.caseId, code, version: active.version, attemptKey: attempt.current },
      {
        onSuccess: () => {
          haptic.success();
          setActive(null);
          toast.show('Order handed to you', 'It is now your delivery — open your active job to finish it.');
          onTakenOver?.();
        },
        onError: (e: unknown) => {
          // A lost answer or an in-flight duplicate keeps the key (the retry
          // replays); a refused code is a new attempt; a handoff that is over
          // closes the dialog and refreshes the list.
          const act = relayErrorAction(e);
          if (act.rotateKey) attempt.current = newAttemptKey(active.caseId);
          if (act.clearCode) setCode('');
          if (act.closeDialog) setActive(null);
          if (act.refresh) void tasks.refetch();
          toast.show(act.message);
        },
      },
    );
  };

  return (
    <>
      {list.map((t) => (
        <DCard key={t.caseId} style={{ marginTop: space.md, borderColor: dk.accentBorder }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Feather name="repeat" size={15} color={dk.accent} />
            <T variant="caption" weight="bold" style={{ color: dk.accent, letterSpacing: 1 }}>RELAY HANDOFF</T>
          </View>
          <T variant="body" weight="bold" style={{ color: dk.text, marginTop: 4 }}>
            Take over order {t.orderNumber}
          </T>
          <T variant="label" style={{ color: dk.muted, marginTop: 2 }}>{t.instruction}</T>
          {t.holderLat != null && t.holderLng != null ? (
            <PillButton
              label={`Navigate to ${t.holderFirstName ?? 'the rider'}`}
              variant="soft"
              icon="navigation"
              style={{ marginTop: space.sm }}
              onPress={() => { void openExternal(`https://www.google.com/maps/dir/?api=1&destination=${t.holderLat},${t.holderLng}`); }}
            />
          ) : null}
          <PillButton label="Enter the handoff code" style={{ marginTop: space.sm }} onPress={() => openTask(t)} />
          <PillButton
            label="I can't take this"
            variant="soft"
            style={{ marginTop: space.sm }}
            disabled={decline.isPending}
            onPress={() => decline.mutate(
              { caseId: t.caseId },
              {
                onSuccess: () => toast.show('Relay declined', 'Swift will ask another rider.'),
                onError: (e: unknown) => { void tasks.refetch(); toast.show(declineErrorMessage(e)); },
              },
            )}
          />
        </DCard>
      ))}

      <PopupCard visible={!!active} onClose={() => { if (!transfer.isPending) setActive(null); }}>
        <PopupTitle variant="title" center>Handoff code</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {active && active.floatToBring > 0
            ? `Give ${active.holderFirstName ?? 'the rider'} the order's ${moneyIn(active.floatToBring)} cash float, take the order, then type the code they show you.`
            : `Take the order from ${active?.holderFirstName ?? 'the rider'}, then type the code they show you.`}
        </T>
        <View style={{ marginTop: space.lg }}>
          <CodeInput value={code} onChange={setCode} length={6} />
        </View>
        <PillButton
          label="Confirm handoff"
          style={{ alignSelf: 'stretch', marginTop: space.lg }}
          disabled={!isHandoffCode(code) || transfer.isPending}
          onPress={submit}
        />
      </PopupCard>
    </>
  );
}
