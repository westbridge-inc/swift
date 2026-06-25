import { useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Button, PressableScale } from '../../../components/ui';
import { useRateOrder } from '../../../hooks';

function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <View className="flex-row" style={{ gap: 10 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <PressableScale key={i} onPress={() => onChange(i)} hitSlop={4}>
          <MaterialCommunityIcons
            name={i <= value ? 'star' : 'star-outline'}
            size={40}
            color={i <= value ? color.brand[500] : color.border.strong}
          />
        </PressableScale>
      ))}
    </View>
  );
}

export function RateOrderScreen({ navigation, route }: any) {
  const orderId: string = route?.params?.orderId ?? '';
  const vendorName: string = route?.params?.vendorName ?? 'your order';
  const hasRider = !!route?.params?.hasRider;

  const [vendorScore, setVendorScore] = useState(0);
  const [vendorComment, setVendorComment] = useState('');
  const [riderScore, setRiderScore] = useState(0);
  const rate = useRateOrder(orderId);

  const submit = () => {
    if (!vendorScore) return;
    rate.mutate(
      {
        vendorScore,
        vendorComment: vendorComment.trim() || undefined,
        ...(hasRider && riderScore ? { riderScore } : {}),
      },
      { onSuccess: () => navigation?.goBack?.() },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md flex-1 text-base font-bold text-text-primary">Rate your order</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View className="px-lg pt-md">
          <Heading size="2xl">How was {vendorName}?</Heading>
          <Text className="mt-xs text-sm text-text-secondary">Your rating helps other customers — and the vendor keeps 100% either way.</Text>
          <View className="mt-lg items-center"><StarPicker value={vendorScore} onChange={setVendorScore} /></View>

          <TextInput
            value={vendorComment}
            onChangeText={setVendorComment}
            placeholder="Tell others what you liked (optional)…"
            placeholderTextColor={color.text.muted}
            multiline
            className="mt-lg rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
            style={{ minHeight: 80 }}
          />

          {hasRider ? (
            <View className="mt-2xl">
              <Heading size="lg">How was your delivery?</Heading>
              <Text className="mt-xs text-sm text-text-secondary">100% of what you tipped goes to your rider.</Text>
              <View className="mt-md items-center"><StarPicker value={riderScore} onChange={setRiderScore} /></View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View className="border-t border-border-subtle bg-surface-base px-lg pb-md pt-md">
        {rate.isError ? <Text className="mb-sm text-center text-sm text-error">Couldn’t submit — try again.</Text> : null}
        <Button label="Submit rating" loading={rate.isPending} disabled={!vendorScore} onPress={submit} />
      </View>
    </SafeAreaView>
  );
}
