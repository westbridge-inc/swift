import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Button, Input, PressableScale } from '../../../components/ui';
import { useAddAddress } from '../../../hooks';

const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551 };

export function AddAddressScreen({ navigation }: any) {
  const addAddress = useAddAddress();
  const [label, setLabel] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('Georgetown');
  const [region, setRegion] = useState('');
  const [instructions, setInstructions] = useState('');
  const [coord, setCoord] = useState(GEORGETOWN);

  const valid = label.trim().length >= 1 && line1.trim().length >= 1 && city.trim().length >= 1;

  const submit = () => {
    if (!valid) return;
    addAddress.mutate(
      {
        label: label.trim(),
        addressLine1: line1.trim(),
        addressLine2: line2.trim() || undefined,
        city: city.trim(),
        region: region.trim() || undefined,
        instructions: instructions.trim() || undefined,
        latitude: coord.latitude,
        longitude: coord.longitude,
      },
      { onSuccess: () => navigation?.goBack?.() },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold">Add address</Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="mx-lg mb-sm overflow-hidden rounded-2xl border border-border-subtle" style={{ height: 200 }}>
          <MapView
            provider={PROVIDER_DEFAULT}
            style={{ flex: 1 }}
            initialRegion={{ ...GEORGETOWN, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
            onPress={(e) => setCoord(e.nativeEvent.coordinate)}
          >
            <Marker
              draggable
              coordinate={coord}
              onDragEnd={(e) => setCoord(e.nativeEvent.coordinate)}
              pinColor={color.brand[500]}
            />
          </MapView>
        </View>
        <Text className="mx-lg mb-md text-xs text-text-muted">
          Drag the pin or tap the map to set the exact spot · {coord.latitude.toFixed(4)}, {coord.longitude.toFixed(4)}
        </Text>

        <View className="px-lg">
          <Input value={label} onChangeText={setLabel} placeholder="Label (e.g. Home, Work)" containerClassName="mb-sm" />
          <Input value={line1} onChangeText={setLine1} placeholder="Street address" containerClassName="mb-sm" />
          <Input value={line2} onChangeText={setLine2} placeholder="Apt / unit (optional)" containerClassName="mb-sm" />
          <Input value={city} onChangeText={setCity} placeholder="City" containerClassName="mb-sm" />
          <Input value={region} onChangeText={setRegion} placeholder="Region (optional)" containerClassName="mb-sm" />
          <Input value={instructions} onChangeText={setInstructions} placeholder="Delivery notes (optional)" containerClassName="mb-sm" />
          {addAddress.isError ? (
            <Text className="mb-sm text-sm text-error">Couldn&apos;t save the address. Try again.</Text>
          ) : null}
          <Button
            label="Save address"
            loading={addAddress.isPending}
            disabled={!valid}
            onPress={submit}
            className="mt-sm"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
