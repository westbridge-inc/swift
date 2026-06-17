import React, { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner } from '../components/ui';
import { DocumentChecklist } from '../components/onboarding/DocumentChecklist';
import { useVerificationStatus, useBecomePartner } from '../hooks/verification';
import { useAuthStore } from '../stores/authStore';

const Stack = createNativeStackNavigator();

const VTYPES = [
  { key: 'BICYCLE', label: 'Bicycle' },
  { key: 'MOTORCYCLE', label: 'Motorcycle' },
  { key: 'CAR', label: 'Car (taxi)' },
] as const;

const FIELD = 'mb-sm rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary';

function VehicleSetup({ onDone }: { onDone: () => void }) {
  const become = useBecomePartner();
  const [vt, setVt] = useState<'BICYCLE' | 'MOTORCYCLE' | 'CAR'>('MOTORCYCLE');
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
    <Card className="mb-lg">
      <Heading size="lg" className="mb-sm">
        Your vehicle
      </Heading>
      <View className="mb-md flex-row" style={{ gap: 8 }}>
        {VTYPES.map((v) => {
          const active = v.key === vt;
          return (
            <Pressable
              key={v.key}
              onPress={() => setVt(v.key)}
              className={
                active
                  ? 'flex-1 items-center rounded-lg border border-brand-500 bg-brand-50 py-sm'
                  : 'flex-1 items-center rounded-lg border border-border-subtle py-sm'
              }
            >
              <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>
                {v.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {isCar ? (
        <>
          <TextInput value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={year} onChangeText={setYear} placeholder="Year" placeholderTextColor={color.text.muted} keyboardType="number-pad" className={FIELD} />
          <TextInput value={colr} onChangeText={setColr} placeholder="Colour" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={plate} onChangeText={setPlate} placeholder="Licence plate" placeholderTextColor={color.text.muted} autoCapitalize="characters" className={FIELD} />
        </>
      ) : null}
      {become.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t save. Try again.</Text> : null}
      <Button label={become.isPending ? 'Saving…' : 'Save vehicle'} disabled={!valid || become.isPending} onPress={submit} />
    </Card>
  );
}

function MoverOnboarding() {
  const { logout } = useAuthStore();
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER');
  const [vehicleSaved, setVehicleSaved] = useState(false);

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const approved = !!status?.roleVerified;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">Become a mover</Heading>
        <Pressable onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </Pressable>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {approved ? (
          <Card className="mb-lg bg-brand-50">
            <Heading size="lg" className="text-brand-700">
              You&apos;re approved 🎉
            </Heading>
            <Text className="mt-xs text-sm text-text-secondary">
              Going online + live dispatch arrive in the next update.
            </Text>
          </Card>
        ) : (
          <View className="mb-md flex-row items-start rounded-lg bg-brand-50 px-lg py-md">
            <Text className="text-base">🛡️</Text>
            <Text className="ml-sm flex-1 text-sm text-brand-700">
              Set up your vehicle and upload your documents. We verify within 24 hours, then you can go online.
            </Text>
          </View>
        )}

        {!vehicleSaved && !approved ? <VehicleSetup onDone={() => setVehicleSaved(true)} /> : null}
        {vehicleSaved && !approved ? (
          <Card className="mb-lg flex-row items-center">
            <Text className="text-base">✓</Text>
            <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary">Vehicle saved</Text>
          </Card>
        ) : null}

        <DocumentChecklist role="MOVER" status={status} />
      </ScrollView>
    </SafeAreaView>
  );
}

export function MoverStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoverOnboarding" component={MoverOnboarding} />
    </Stack.Navigator>
  );
}
