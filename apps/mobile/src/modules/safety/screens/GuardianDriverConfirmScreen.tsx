import { useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { Header, PillButton, Screen, T } from '../../../kit';
import { useGuardianDriverConfirm } from '../../../hooks/safety';
import {
  isRetryable, messageFor, outcomeOfError, readConfirmRequest, type ConfirmOutcome,
} from '../../../lib/guardianDriverConfirm';

/**
 * [TST-001] THE DRIVER'S HALF OF A TRIP GUARDIAN CHECK.
 *
 * When a passenger does not answer a check-in, the platform asks the driver to
 * confirm the trip's status before it escalates. The push existed. The
 * endpoint existed. There was nowhere to answer: the notification routed to
 * `Delivery`, a screen MoverStack never mounts, and the census test asserted
 * that dead end as passing with a comment admitting it.
 *
 * Everything on this screen is a fact from the push or the server: the cycle
 * and the nonce identify the question (a stale notification cannot resolve a
 * different check), the deadline is the server's, and every outcome names what
 * it means for the person the check is about.
 */
export function GuardianDriverConfirmScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const request = readConfirmRequest(route.params ?? {});
  const confirm = useGuardianDriverConfirm();
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null);

  const submit = () => {
    if (request.state !== 'ready' || confirm.isPending) return;
    confirm.mutate(
      { cycleId: request.cycleId, nonce: request.nonce },
      {
        onSuccess: () => setOutcome('confirmed'),
        onError: (error) => setOutcome(outcomeOfError(error)),
      },
    );
  };

  const done = outcome !== null && !isRetryable(outcome);

  return (
    <Screen>
      <Header title="Trip status check" onBack={() => navigation.goBack()} />
      <View style={{ paddingHorizontal: space.xl, paddingTop: space.xl }}>
        <Feather name="shield" size={28} color={color.brand[500]} />
        <T variant="title" weight="bold" style={{ marginTop: space.md }}>
          Is this trip going normally?
        </T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Your passenger did not answer a safety check-in. Confirming tells us the trip is fine.
          If something is wrong, use the emergency button instead — this is not the place to report it.
        </T>

        {request.state === 'expired' ? (
          <T variant="label" tone="muted" style={{ marginTop: space.xl }}>
            {messageFor('expired')}
          </T>
        ) : request.state === 'unanswerable' ? (
          <T variant="label" tone="muted" style={{ marginTop: space.xl }}>
            This check can no longer be opened from here. Our safety team has it.
          </T>
        ) : (
          <>
            {request.respondBy ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.lg }}>
                Please answer by {request.respondBy.toLocaleTimeString()}.
              </T>
            ) : null}
            {outcome ? (
              <T
                variant="label"
                tone={outcome === 'confirmed' || outcome === 'already_answered' ? 'muted' : 'error'}
                style={{ marginTop: space.xl }}
              >
                {messageFor(outcome)}
              </T>
            ) : null}
            <View style={{ marginTop: space.xl }}>
              {done ? (
                <PillButton label="Back to my job" onPress={() => navigation.goBack()} />
              ) : (
                <PillButton
                  label={outcome === 'unreachable' ? 'Try again' : 'Yes, the trip is fine'}
                  loading={confirm.isPending}
                  onPress={submit}
                />
              )}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
