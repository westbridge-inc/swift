/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, LabeledInput, LinkText, PillButton, Screen, T } from '../../../kit';
import { SwiftMark } from '../../../components/SwiftLogo';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { useVerificationStatus, useBecomePartner } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { GUTTER } from '../shared';

type VehicleKind = 'BICYCLE' | 'MOTORCYCLE' | 'CAR';

const VTYPES: { key: VehicleKind; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'BICYCLE', label: 'Bicycle', icon: 'bike', hint: 'Deliveries' },
  { key: 'MOTORCYCLE', label: 'Motorcycle', icon: 'moped', hint: 'Deliveries' },
  { key: 'CAR', label: 'Car', icon: 'car', hint: 'Taxi + rides' },
];

function ValuePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9999, paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: color.brand[50] }}>
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <T variant="caption" weight="bold" tone="deep">
        {label}
      </T>
    </View>
  );
}

function VehicleTile({ v, active, onPress }: { v: (typeof VTYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1 }}>
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            borderRadius: radius.lg,
            borderWidth: 1,
            paddingVertical: space.md,
            borderColor: active ? color.brand[500] : color.border.subtle,
            backgroundColor: active ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 4, backgroundColor: active ? color.brand[500] : color.surface.subtle }}>
            <MaterialCommunityIcons name={v.icon} size={22} color={active ? color.white : color.text.secondary} />
          </View>
          <T variant="label" weight="bold" tone={active ? 'deep' : 'ink'}>
            {v.label}
          </T>
          <T variant="caption" tone="muted">
            {v.hint}
          </T>
        </View>
      )}
    </Pressable>
  );
}

function VehicleSetup({ vt, setVt, onDone }: { vt: VehicleKind; setVt: (v: VehicleKind) => void; onDone: () => void }) {
  const become = useBecomePartner();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [colr, setColr] = useState('');
  const [plate, setPlate] = useState('');
  const isCar = vt === 'CAR';
  const valid = !isCar || (!!make && !!model && !!year && !!colr && !!plate);

  const submit = () => {
    become.mutate(
      {
        role: 'MOVER',
        vehicleType: vt,
        vehicle: isCar ? { make, model, year: Number(year) || 0, color: colr, licensePlate: plate } : undefined,
      },
      { onSuccess: onDone },
    );
  };

  return (
    <Card>
      <T variant="heading">Your vehicle</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        How will you earn?
      </T>
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        {VTYPES.map((v) => (
          <VehicleTile key={v.key} v={v} active={v.key === vt} onPress={() => setVt(v.key)} />
        ))}
      </View>
      {isCar ? (
        <View style={{ gap: space.md, marginTop: space.md }}>
          <LabeledInput value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" />
          <LabeledInput value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <LabeledInput containerStyle={{ flex: 1 }} value={year} onChangeText={setYear} placeholder="Year" keyboardType="number-pad" />
            <LabeledInput containerStyle={{ flex: 1 }} value={colr} onChangeText={setColr} placeholder="Colour" />
          </View>
          <LabeledInput value={plate} onChangeText={setPlate} placeholder="Licence plate" autoCapitalize="characters" />
        </View>
      ) : null}
      {become.isError ? (
        <T variant="label" tone="error" style={{ marginTop: space.md }}>
          Couldn&apos;t save. Try again.
        </T>
      ) : null}
      <PillButton label="Save vehicle" loading={become.isPending} disabled={!valid} style={{ marginTop: space.md }} onPress={submit} />
    </Card>
  );
}

export function MoverOnboardingScreen({ status }: { status: any }) {
  const { logout } = useAuthStore();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const savedVehicle: VehicleKind | null = status?.vehicleType ?? null;
  const [vt, setVt] = useState<VehicleKind>(savedVehicle ?? 'MOTORCYCLE');
  const [vehicleSaved, setVehicleSaved] = useState(!!savedVehicle);
  const { data: preview } = useVerificationStatus<any>('MOVER', vt);
  const checklistStatus = preview ?? status;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: GUTTER, height: 56 }}>
        <SwiftMark size={28} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <LinkText label="Switch app" onPress={() => setSwitcherOpen(true)} />
          <LinkText label="Log out" tone="muted" onPress={logout} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <T variant="title" style={{ marginTop: space.sm }}>
          Start earning with Swift
        </T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Set up your vehicle and documents — we verify within 24 hours, then you go online and start earning.
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg }}>
          <ValuePill icon="check-decagram" label="Keep 100%" />
          <ValuePill icon="cash" label="Cash payouts" />
          <ValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        <View style={{ marginTop: space.xl }}>
          {!vehicleSaved ? (
            <VehicleSetup vt={vt} setVt={setVt} onDone={() => setVehicleSaved(true)} />
          ) : (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F6EE' }}>
                <MaterialCommunityIcons name="check" size={20} color={color.success} />
              </View>
              <T variant="body" weight="bold" style={{ flex: 1 }}>
                Vehicle saved
              </T>
            </Card>
          )}
        </View>

        <View style={{ marginTop: space.xl }}>
          <DocumentChecklist role="MOVER" status={checklistStatus} />
        </View>
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
    </Screen>
  );
}
