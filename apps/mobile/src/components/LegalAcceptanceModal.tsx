/** @jsxImportSource react */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { authApi, API_URL } from '../services/api';
import { openPayLink } from '../lib/payLink';
import { useAuthStore } from '../stores/authStore';
import { BrandCheckbox, PillButton, T } from '../kit';
import { AGREEMENT_LABEL, AGREEMENT_PATH, DECLINE_LINE, acceptLabel, acceptTitle, type LegalAcceptance } from '../lib/legalAcceptanceCopy';

/**
 * [R26 · legal research G2 · Terms "Changes"] Phone build 12: when the legal texts change materially, a signed-in
 * person sees what changed and accepts with a fresh, unticked tick before carrying on ("continued use" is not
 * acceptance). The server decides who is asked (GET /auth/legal-acceptance); an older API answers 404 and nothing
 * is shown. Builds 9-11 do not have this screen and the server never blocks them.
 */
export function LegalAcceptanceModal() {
  const { isAuthenticated, sessionGeneration } = useAuthStore();
  const qc = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const status = useQuery({
    queryKey: ['legal-acceptance', sessionGeneration],
    enabled: isAuthenticated,
    retry: false,
    queryFn: async () => (await authApi.legalAcceptance()).data?.data as LegalAcceptance,
  });
  const accept = useMutation({
    mutationFn: async (version: string) => (await authApi.acceptLegal(version)).data?.data as LegalAcceptance,
    onSuccess: (next) => { qc.setQueryData(['legal-acceptance', sessionGeneration], next); setTicked(false); },
    // The words may have changed while they read: show the new ones, unticked.
    onError: () => { setTicked(false); void status.refetch(); },
  });

  const s = status.data;
  if (!isAuthenticated || !s?.needsAcceptance) return null;

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={() => {}}>
      <ScrollView contentContainerStyle={{ padding: space['2xl'], paddingTop: space['3xl'], backgroundColor: color.surface.base, flexGrow: 1 }}>
        <T variant="title">{acceptTitle(s)}</T>
        {s.summary.length ? (
          <View style={{ marginTop: space.lg, gap: space.sm }} testID="legal-accept-summary">
            <T variant="label" tone="muted">What changed:</T>
            {s.summary.map((line) => <T key={line} variant="body">• {line}</T>)}
          </View>
        ) : null}
        <View style={{ marginTop: space.xl, gap: space.xs }}>
          <T variant="label" weight="semibold" tone="brand" onPress={() => openPayLink(`${API_URL}/legal/terms`)}>Read the Terms of Service</T>
          <T variant="label" weight="semibold" tone="brand" onPress={() => openPayLink(`${API_URL}/legal/privacy`)}>Read the Privacy Policy</T>
          {s.agreements.map((a) => (
            <T key={a} variant="label" weight="semibold" tone="brand" onPress={() => openPayLink(`${API_URL}/legal/${AGREEMENT_PATH[a]}`)}>Read the {AGREEMENT_LABEL[a]}</T>
          ))}
        </View>
        <Pressable
          onPress={() => setTicked((t) => !t)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ticked }}
          accessibilityLabel={acceptLabel(s)}
          testID="legal-accept-tick"
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl, borderRadius: radius.md }}
        >
          <BrandCheckbox checked={ticked} onToggle={() => setTicked((t) => !t)} />
          <T variant="label" style={{ flex: 1 }}>{acceptLabel(s)}</T>
        </Pressable>
        {accept.isError ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            {(accept.error as any)?.response?.data?.error?.message ?? 'That did not go through. Please try again.'}
          </T>
        ) : null}
        <PillButton
          label="Accept and continue"
          disabled={!ticked}
          loading={accept.isPending}
          onPress={() => accept.mutate(s.currentVersion)}
          style={{ marginTop: space.xl }}
          testID="legal-accept-button"
        />
        <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>{DECLINE_LINE}</T>
      </ScrollView>
    </Modal>
  );
}
