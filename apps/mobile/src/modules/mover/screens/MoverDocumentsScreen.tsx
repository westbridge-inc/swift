/** @jsxImportSource react */
import React from 'react';
import { ScrollView } from 'react-native';
import { space } from '@swift/ui';
import { Header, Screen } from '../../../kit';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { useVerificationStatus } from '../../../hooks';
import { GUTTER } from '../shared';

/**
 * A verified mover's renewal surface: the same checklist as onboarding, now
 * carrying live expiry state — an approved document re-opens for upload once
 * it enters the 30-day renewal window, so nobody has to lapse to resubmit.
 */
export function MoverDocumentsScreen() {
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>('MOVER');

  return (
    <Screen>
      <Header title="Documents" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
      >
        <DocumentChecklist role="MOVER" status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
      </ScrollView>
    </Screen>
  );
}
