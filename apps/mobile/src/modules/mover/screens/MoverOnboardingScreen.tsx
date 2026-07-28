/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, LabeledInput, LinkText, PillButton, Screen, T } from '../../../kit';
import { SwiftMark } from '../../../components/SwiftLogo';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { PricingCard } from '../../../components/onboarding/PricingCard';
import { useVerificationStatus, useBecomePartner } from '../../../hooks';
import { DRIVER_VEHICLE_KINDS, type VehicleKind } from '../../../services/api';
import { useAuthStore } from '../../../stores/authStore';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { GUTTER } from '../shared';

// The full Guyana fleet, small → large. Order matches the vehicle-class
// taxonomy on the server (config/vehicle-classes). Only CAR provisions a taxi
// Driver (and collects vehicle details below); the rest register a delivery/
// courier Rider — details and commercial docs follow in the Documents step.
const VTYPES: { key: VehicleKind; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'BICYCLE', label: 'Bicycle', icon: 'bike', hint: 'Small deliveries' },
  { key: 'MOTORCYCLE', label: 'Motorbike', icon: 'moped', hint: 'Deliveries' },
  { key: 'CAR', label: 'Car', icon: 'car', hint: 'Taxi + delivery' },
  { key: 'WAGON_CAR', label: 'Wagon Car', icon: 'car-estate', hint: 'Taxi + larger loads' },
  { key: 'BUS_9', label: 'Bus (9-seater)', icon: 'van-passenger', hint: 'Groups & tours' },
  { key: 'BUS_15', label: 'Bus (15-seater)', icon: 'bus', hint: 'Groups & airport runs' },
  { key: 'CANTER_SHORT', label: 'Short-Base Canter (Open Back)', icon: 'truck-flatbed', hint: 'Open cargo' },
  { key: 'CANTER_LONG', label: 'Long-Base Canter (Open Back)', icon: 'truck-flatbed', hint: 'Large open cargo' },
  { key: 'BOX_TRUCK_SHORT', label: 'Short-Base Box Truck', icon: 'truck', hint: 'Enclosed cargo' },
  { key: 'BOX_TRUCK_LONG', label: 'Long-Base Box Truck', icon: 'truck-delivery', hint: 'Large enclosed cargo' },
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

function VehicleRow({ v, active, onPress }: { v: (typeof VTYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            padding: space.md,
            borderColor: active ? color.brand[500] : color.border.subtle,
            backgroundColor: active ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? color.brand[500] : color.surface.subtle }}>
            <MaterialCommunityIcons name={v.icon} size={22} color={active ? color.white : color.text.secondary} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="label" weight="bold" tone={active ? 'deep' : 'ink'}>
              {v.label}
            </T>
            <T variant="caption" tone="muted">
              {v.hint}
            </T>
          </View>
          <MaterialCommunityIcons
            name={active ? 'check-circle' : 'circle-outline'}
            size={22}
            color={active ? color.brand[500] : color.border.subtle}
          />
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
  const needsDetails = DRIVER_VEHICLE_KINDS.includes(vt);
  const valid = !needsDetails || (!!make && !!model && !!year && !!colr && !!plate);

  const submit = () => {
    become.mutate(
      {
        role: 'MOVER',
        vehicleType: vt,
        vehicle: needsDetails ? { make, model, year: Number(year) || 0, color: colr, licensePlate: plate } : undefined,
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
      <View style={{ gap: space.sm, marginTop: space.md }}>
        {VTYPES.map((v) => (
          <VehicleRow key={v.key} v={v} active={v.key === vt} onPress={() => setVt(v.key)} />
        ))}
      </View>
      {needsDetails ? (
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
  const { logout, moverPreset } = useAuthStore();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const savedVehicle: VehicleKind | null = status?.vehicleType ?? null;
  // Default the vehicle from what they picked on the entry screen: a taxi
  // driver starts on Car, a rider on Motorcycle. A saved vehicle always wins.
  const presetVehicle: VehicleKind = moverPreset === 'taxi' ? 'CAR' : 'MOTORCYCLE';
  const [vt, setVt] = useState<VehicleKind>(savedVehicle ?? presetVehicle);
  const [vehicleSaved, setVehicleSaved] = useState(!!savedVehicle);
  const { data: preview, isLoading: statusLoading, isError: statusError, refetch: refetchStatus } = useVerificationStatus<any>('MOVER', vt);
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

        {/* The price on the door — what "flat weekly fee" actually costs. */}
        <View style={{ marginTop: space.lg }}>
          <PricingCard kind="mover" />
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
          <DocumentChecklist
            role="MOVER"
            status={checklistStatus}
            isLoading={!checklistStatus && statusLoading}
            isError={!checklistStatus && statusError}
            onRetry={refetchStatus}
          />
        </View>
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
    </Screen>
  );
}
