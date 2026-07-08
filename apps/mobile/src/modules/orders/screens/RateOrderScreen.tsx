import { useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Button, PressableScale } from '../../../components/ui';
import { useOrder, useRateOrder } from '../../../hooks';
import { mediaUrl, vendorImage } from '../../../lib/images';

/** Kit feedback stars — gold when set, quiet outline otherwise. */
function StarPicker({ value, onChange, size = 44 }: { value: number; onChange: (n: number) => void; size?: number }) {
  return (
    <View className="flex-row items-center justify-center" style={{ gap: 8 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <PressableScale key={i} onPress={() => onChange(i)} hitSlop={4}>
          <MaterialCommunityIcons
            name={i <= value ? 'star' : 'star-outline'}
            size={size}
            color={i <= value ? color.warning : color.border.strong}
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

  // Read-only enrichment: the order detail carries the vendor logo + rider
  // identity so the feedback screen can show WHO is being rated (kit 45/47).
  const { data: order } = useOrder<any>(orderId);
  const vendorLogo = order?.vendor ? vendorImage(order.vendor) : null;
  const riderName: string = order?.rider?.firstName ?? 'your rider';
  const riderAvatar = mediaUrl(order?.rider?.avatar);

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
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top', 'bottom']}>
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md flex-1 text-base font-semibold text-text-primary">Rate your order</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View className="px-lg pt-lg">
          {/* Subject — kit centers who's being rated */}
          <View className="items-center">
            {vendorLogo ? (
              <Image source={{ uri: vendorLogo }} style={{ width: 96, height: 96, borderRadius: 48 }} contentFit="cover" transition={150} />
            ) : (
              <View className="items-center justify-center" style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: color.brand[50] }}>
                <MaterialCommunityIcons name="storefront-outline" size={40} color={color.brand[500]} />
              </View>
            )}
            <Text className="mt-lg text-center font-display text-2xl font-bold text-text-primary">How was {vendorName}?</Text>
            <Text className="mt-xs text-center text-sm text-text-secondary">
              Your rating helps other customers — and the vendor keeps 100% either way.
            </Text>
          </View>

          <View className="mt-xl"><StarPicker value={vendorScore} onChange={setVendorScore} /></View>

          {/* Kit feedback field — white, hairline, r8 */}
          <Text className="mt-xl text-sm font-medium text-text-primary">Feedback</Text>
          <TextInput
            value={vendorComment}
            onChangeText={setVendorComment}
            placeholder="Tell others what you liked (optional)…"
            placeholderTextColor={color.text.muted}
            multiline
            textAlignVertical="top"
            className="mt-sm bg-surface-base px-lg font-body text-base text-text-primary"
            style={{ minHeight: 100, borderRadius: 8, borderWidth: 1, borderColor: color.border.subtle, paddingVertical: 14 }}
          />

          {hasRider ? (
            <View className="mt-2xl items-center">
              <View style={{ height: 1, alignSelf: 'stretch', backgroundColor: color.border.subtle }} />
              <View className="mt-xl items-center">
                {riderAvatar ? (
                  <Image source={{ uri: riderAvatar }} style={{ width: 56, height: 56, borderRadius: 28 }} contentFit="cover" transition={150} />
                ) : (
                  <View className="items-center justify-center" style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: color.brand[50] }}>
                    <MaterialCommunityIcons name="moped-outline" size={26} color={color.brand[500]} />
                  </View>
                )}
                <Text className="mt-md text-base font-semibold text-text-primary">{riderName}</Text>
                <Text className="mt-xs text-sm text-text-secondary">How was the delivery of your order?</Text>
              </View>
              <View className="mt-md"><StarPicker value={riderScore} onChange={setRiderScore} size={38} /></View>
              <Text className="mt-md text-center text-xs text-text-muted">100% of what you tipped goes to your rider.</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* Kit CTA pair — quiet skip + brand submit */}
      <View className="bg-surface-base px-lg pb-md pt-md" style={{ borderTopWidth: 1, borderTopColor: color.border.subtle }}>
        {rate.isError ? <Text className="mb-sm text-center text-sm text-error">Couldn’t submit — try again.</Text> : null}
        <View className="flex-row" style={{ gap: 12 }}>
          <Button label="Skip" variant="neutral" className="flex-1" onPress={() => navigation?.goBack?.()} />
          <Button label="Submit" className="flex-1" loading={rate.isPending} disabled={!vendorScore} onPress={submit} />
        </View>
      </View>
    </SafeAreaView>
  );
}
