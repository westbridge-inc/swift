import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, PressableScale } from '../../../components/ui';
import { useAddresses } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';

const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551, label: 'Georgetown' };

export function LocationPickerScreen({ navigation }: any) {
  const { data } = useAddresses<any[]>();
  const list = data ?? [];
  const setLocation = useLocationStore((s) => s.setLocation);

  const choose = (lat: number, lng: number, label: string) => {
    setLocation(lat, lng, label);
    navigation?.goBack?.();
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold">Set your location</Text>
      </View>

      <View className="flex-1 px-lg pt-sm">
        {list.map((a) => (
          <PressableScale key={a.id} onPress={() => choose(a.latitude, a.longitude, a.label || a.addressLine1)}>
            <Card className="mb-sm flex-row items-center">
              <MaterialCommunityIcons name="map-marker-outline" size={20} color={color.text.muted} />
              <View className="ml-sm flex-1">
                <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                  {a.addressLine1}{a.city ? `, ${a.city}` : ''}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={color.text.muted} />
            </Card>
          </PressableScale>
        ))}

        <PressableScale onPress={() => choose(GEORGETOWN.latitude, GEORGETOWN.longitude, GEORGETOWN.label)}>
          <Card className="mb-sm flex-row items-center">
            <MaterialCommunityIcons name="crosshairs-gps" size={20} color={color.brand[500]} />
            <Text className="ml-sm flex-1 text-base font-semibold">Use Georgetown (default)</Text>
          </Card>
        </PressableScale>

        <PressableScale onPress={() => navigation?.navigate?.('AddAddress')}>
          <Card className="flex-row items-center">
            <Feather name="plus-circle" size={20} color={color.brand[500]} />
            <Text className="ml-sm flex-1 text-base font-semibold" style={{ color: color.brand[600] }}>Add a new address</Text>
          </Card>
        </PressableScale>
      </View>
    </SafeAreaView>
  );
}
