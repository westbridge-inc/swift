import { useState } from 'react';
import { View, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { Text, Heading, Button } from '../../components/ui';

export function PhoneEntryScreen({ navigation }: any) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const handleSendOtp = async () => {
    setLoading(true);
    setError(false);
    try {
      const full = `+592${phone}`;
      await authApi.sendOtp(full);
      navigation.navigate('OtpVerification', { phone: full });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 justify-center px-lg">
        <Heading size="3xl" className="text-center text-brand-500">
          Swift
        </Heading>
        <Heading size="xl" className="mt-2xl text-center">
          Enter your phone number
        </Heading>
        <Text className="mt-xs text-center text-text-secondary">We&apos;ll text you a verification code.</Text>
        <View className="mt-xl flex-row" style={{ gap: 12 }}>
          <View className="items-center justify-center rounded-lg border border-border-subtle bg-surface-subtle px-lg">
            <Text className="text-base font-semibold">+592</Text>
          </View>
          <TextInput
            value={phone}
            onChangeText={(t) => {
              setPhone(t);
              setError(false);
            }}
            placeholder="Phone number"
            placeholderTextColor={color.text.muted}
            keyboardType="phone-pad"
            autoFocus
            className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-lg text-text-primary"
          />
        </View>
        {error ? <Text className="mt-sm text-center text-sm text-error">Couldn&apos;t send the code. Try again.</Text> : null}
        <Button label={loading ? 'Sending…' : 'Continue'} className="mt-xl" disabled={!phone || loading} onPress={handleSendOtp} />
      </View>
    </SafeAreaView>
  );
}
