/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { space } from '@swift/ui';
import { Header, Screen } from '../../../kit';
import { toast } from '../../../kit/toast';
import { useMoverKind } from '../../../hooks';
import { useStepUp } from '../../../hooks/useStepUp';
import type { VehicleKind } from '../../../services/api';
import { VehicleSetup } from './MoverOnboardingScreen';
import { GUTTER } from '../shared';

/**
 * [VEHICLES] A working mover changes vehicle. The same picker as onboarding, in
 * change mode: the server takes them offline, retires the papers about the old
 * vehicle and asks a verified mover to confirm it is them (step-up), so the
 * next stop is the documents screen, where the new vehicle's papers go in.
 */
export function MoverVehicleScreen({ navigation }: any) {
  const { profile } = useMoverKind();
  const current = (profile?.vehicleType ?? null) as VehicleKind | null;
  const [vt, setVt] = useState<VehicleKind>(current ?? 'MOTORCYCLE');
  const stepUp = useStepUp();

  return (
    <Screen>
      <Header title="Your vehicle" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
      >
        <VehicleSetup
          mode="change"
          current={current}
          vt={vt}
          setVt={setVt}
          guard={stepUp.withStepUp}
          onDone={(changed) => {
            if (!changed) {
              toast.show('No change', 'That is already your vehicle.');
              return;
            }
            toast.success('Vehicle changed', 'Add its documents — you can go online once they’re approved.');
            navigation?.navigate?.('MoverDocuments');
          }}
        />
      </ScrollView>
      {stepUp.sheet}
    </Screen>
  );
}
