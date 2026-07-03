import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Button, PressableScale, Input, elevation } from '../../../components/ui';
import { SwiftMark } from '../../../components/SwiftLogo';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { useVerificationStatus, useBecomePartner } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';

type VehicleKind = 'BICYCLE' | 'MOTORCYCLE' | 'CAR';

const VTYPES: { key: VehicleKind; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'BICYCLE', label: 'Bicycle', icon: 'bike', hint: 'Deliveries' },
  { key: 'MOTORCYCLE', label: 'Motorcycle', icon: 'moped', hint: 'Deliveries' },
  { key: 'CAR', label: 'Car', icon: 'car', hint: 'Taxi + rides' },
];

function ValuePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View className="flex-row items-center rounded-full px-3 py-1.5" style={{ backgroundColor: color.brand[50] }}>
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <Text className="ml-1.5 text-xs font-bold" style={{ color: color.brand[700] }}>{label}</Text>
    </View>
  );
}

function VehicleTile({ v, active, onPress }: { v: (typeof VTYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} style={{ flex: 1 }}>
      <View
        className={
          active
            ? 'items-center rounded-2xl border-2 py-md'
            : 'items-center rounded-2xl border border-border-subtle bg-surface-base py-md'
        }
        style={active ? { borderColor: color.brand[500], backgroundColor: color.brand[50] } : undefined}
      >
        <View
          className="mb-1 h-11 w-11 items-center justify-center rounded-full"
          style={{ backgroundColor: active ? color.brand[500] : color.surface.subtle }}
        >
          <MaterialCommunityIcons name={v.icon} size={22} color={active ? '#fff' : color.text.secondary} />
        </View>
        <Text style={active ? { color: color.brand[700] } : undefined} className={active ? 'text-sm font-bold' : 'text-sm font-bold text-text-primary'}>{v.label}</Text>
        <Text className="text-[10px] text-text-muted">{v.hint}</Text>
      </View>
    </PressableScale>
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
    <View className="rounded-3xl bg-surface-base p-lg" style={elevation.card}>
      <Heading size="lg">Your vehicle</Heading>
      <Text className="mt-xs text-sm text-text-secondary">How will you earn?</Text>
      <View className="mt-md flex-row" style={{ gap: 8 }}>
        {VTYPES.map((v) => (
          <VehicleTile key={v.key} v={v} active={v.key === vt} onPress={() => setVt(v.key)} />
        ))}
      </View>
      {isCar ? (
        <View className="mt-md" style={{ gap: 8 }}>
          <Input value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" />
          <Input value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" />
          <View className="flex-row" style={{ gap: 8 }}>
            <Input containerClassName="flex-1" value={year} onChangeText={setYear} placeholder="Year" keyboardType="number-pad" />
            <Input containerClassName="flex-1" value={colr} onChangeText={setColr} placeholder="Colour" />
          </View>
          <Input value={plate} onChangeText={setPlate} placeholder="Licence plate" autoCapitalize="characters" />
        </View>
      ) : null}
      {become.isError ? <Text className="mt-sm text-sm text-error">Couldn&apos;t save. Try again.</Text> : null}
      <Button label="Save vehicle" loading={become.isPending} disabled={!valid} className="mt-md" onPress={submit} />
    </View>
  );
}

export function MoverOnboardingScreen({ status }: { status: any }) {
  const { logout } = useAuthStore();
  const savedVehicle: VehicleKind | null = status?.vehicleType ?? null;
  const [vt, setVt] = useState<VehicleKind>(savedVehicle ?? 'MOTORCYCLE');
  const [vehicleSaved, setVehicleSaved] = useState(!!savedVehicle);
  const { data: preview } = useVerificationStatus<any>('MOVER', vt);
  const checklistStatus = preview ?? status;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <SwiftMark size={28} />
        <PressableScale onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </PressableScale>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Heading size="2xl" className="mt-sm">Start earning with Swift</Heading>
        <Text className="mt-xs text-[15px] leading-5 text-text-secondary">
          Set up your vehicle and documents — we verify within 24 hours, then you go online and start earning.
        </Text>
        <View className="mt-md flex-row flex-wrap" style={{ gap: 8 }}>
          <ValuePill icon="check-decagram" label="Keep 100%" />
          <ValuePill icon="cash" label="Cash payouts" />
          <ValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        <View className="mt-lg">
          {!vehicleSaved ? (
            <VehicleSetup vt={vt} setVt={setVt} onDone={() => setVehicleSaved(true)} />
          ) : (
            <View className="flex-row items-center rounded-3xl bg-surface-base p-lg" style={elevation.card}>
              <View className="h-10 w-10 items-center justify-center rounded-full bg-success/10">
                <MaterialCommunityIcons name="check" size={20} color={color.success} />
              </View>
              <Text className="ml-md flex-1 text-base font-bold text-text-primary">Vehicle saved</Text>
            </View>
          )}
        </View>

        <View className="mt-lg">
          <DocumentChecklist role="MOVER" status={checklistStatus} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
