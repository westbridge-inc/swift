import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, PressableScale, Input, ChoiceChip } from '../../../components/ui';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { useVerificationStatus, useBecomePartner } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';

type VehicleKind = 'BICYCLE' | 'MOTORCYCLE' | 'CAR';

const VTYPES: { key: VehicleKind; label: string }[] = [
  { key: 'BICYCLE', label: 'Bicycle' },
  { key: 'MOTORCYCLE', label: 'Motorcycle' },
  { key: 'CAR', label: 'Car (taxi)' },
];

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
    <Card className="mb-lg gap-sm">
      <Heading size="lg" className="mb-xs">Your vehicle</Heading>
      <View className="mb-xs flex-row" style={{ gap: 8 }}>
        {VTYPES.map((v) => (
          <ChoiceChip key={v.key} label={v.label} active={v.key === vt} onPress={() => setVt(v.key)} full />
        ))}
      </View>
      {isCar ? (
        <>
          <Input value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" />
          <Input value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" />
          <Input value={year} onChangeText={setYear} placeholder="Year" keyboardType="number-pad" />
          <Input value={colr} onChangeText={setColr} placeholder="Colour" />
          <Input value={plate} onChangeText={setPlate} placeholder="Licence plate" autoCapitalize="characters" />
        </>
      ) : null}
      {become.isError ? <Text className="text-sm text-error">Couldn&apos;t save. Try again.</Text> : null}
      <Button label="Save vehicle" loading={become.isPending} disabled={!valid} onPress={submit} />
    </Card>
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">Become a mover</Heading>
        <PressableScale onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </PressableScale>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="mb-md flex-row items-start rounded-xl bg-surface-subtle px-lg py-md">
          <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[500]} />
          <Text className="ml-sm flex-1 text-sm text-text-secondary">
            Set up your vehicle and upload your documents. We verify within 24 hours, then you can go online and start earning.
          </Text>
        </View>
        {!vehicleSaved ? (
          <VehicleSetup vt={vt} setVt={setVt} onDone={() => setVehicleSaved(true)} />
        ) : (
          <Card className="mb-lg flex-row items-center">
            <Feather name="check-circle" size={18} color={color.success} />
            <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary">Vehicle saved</Text>
          </Card>
        )}
        <DocumentChecklist role="MOVER" status={checklistStatus} />
      </ScrollView>
    </SafeAreaView>
  );
}
