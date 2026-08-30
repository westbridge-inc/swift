/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { CodeInput, IconChip, PillButton, PopupCard, PopupTitle, T } from '../kit';
import { authApi } from '../services/api';
import { serverMessage } from '../lib/stepUp';

const RESEND_COOLDOWN_S = 60;
const CODE_LEN = 6;

/**
 * [ALG-34] "Confirm it's you" — the code sheet a money surface opens when the
 * server answers STEP_UP_REQUIRED. Sends on open, verifies on six digits, and
 * hands control back through onVerified so the caller retries its own call.
 * Every error line is the server's sentence: the server owns the lock, the
 * cooldown and the budget, so the sheet never guesses a reason.
 */
export function StepUpSheet({ visible, onVerified, onClose }: { visible: boolean; onVerified: () => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const send = useMutation({
    mutationFn: async () => (await authApi.stepUp()).data?.data as { sentTo?: string } | undefined,
    onSuccess: (d) => {
      setSentTo(d?.sentTo ?? null);
      setCooldown(RESEND_COOLDOWN_S);
    },
  });
  const verify = useMutation({
    mutationFn: (c: string) => authApi.verifyStepUp(c),
    onSuccess: () => {
      setCode('');
      onVerified();
    },
  });

  // Sends once per open. The mutation objects are recreated each render, so
  // the effect keys on `visible` alone by design.
  useEffect(() => {
    if (!visible) return;
    setCode('');
    setSentTo(null);
    verify.reset();
    send.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = (c: string) => {
    if (c.length !== CODE_LEN || verify.isPending) return;
    verify.mutate(c);
  };

  const sendError = send.isError ? serverMessage(send.error, "We couldn't send the code. Try again in a moment.") : null;
  const verifyError = verify.isError ? serverMessage(verify.error, 'That code is not right.') : null;
  const message = verifyError ?? sendError;

  return (
    <PopupCard visible={visible} onClose={onClose}>
      <IconChip icon="shield" size={56} tone="brand" />
      <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
        Confirm it’s you
      </PopupTitle>
      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        {sentTo
          ? `This changes where your money goes, so we texted a code to ${sentTo}.`
          : 'This changes where your money goes, so we’re texting a code to the phone on this account.'}
      </T>
      <View style={{ marginTop: space.lg, alignSelf: 'stretch' }} testID="step-up-code-entry">
        <CodeInput
          value={code}
          onChange={(v) => {
            if (verify.isError) verify.reset();
            setCode(v);
            if (v.length === CODE_LEN) submit(v);
          }}
          length={CODE_LEN}
          error={verify.isError}
          autoFocus
        />
      </View>
      {message ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ marginTop: space.md }}>
          <T variant="label" tone="error" center>
            {message}
          </T>
        </View>
      ) : null}
      <PillButton
        label={verify.isPending ? 'Checking…' : 'Confirm'}
        loading={verify.isPending}
        disabled={code.length !== CODE_LEN || verify.isPending}
        style={{ alignSelf: 'stretch', marginTop: space.lg }}
        onPress={() => submit(code)}
      />
      <PillButton
        label={cooldown > 0 ? `Resend in ${cooldown}s` : send.isPending ? 'Sending…' : 'Resend code'}
        variant="soft"
        size="md"
        disabled={cooldown > 0 || send.isPending}
        style={{ alignSelf: 'stretch', marginTop: space.sm }}
        onPress={() => send.mutate()}
      />
      <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>
        Swift will never ask you for this code.
      </T>
    </PopupCard>
  );
}
