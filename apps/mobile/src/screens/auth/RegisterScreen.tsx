import { useState } from 'react';
import { View, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authApi, customerApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, Button, Field } from '../../components/ui';

export function RegisterScreen({ route }: any) {
  const phone = route?.params?.phone;
  const intent = useAuthStore((s) => s.intent);
  const role = (intent === 'mover' ? 'MOVER' : intent === 'vendor' ? 'VENDOR' : 'CUSTOMER') as
    | 'CUSTOMER'
    | 'MOVER'
    | 'VENDOR';
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [referral, setReferral] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const { setAuth, countryCode } = useAuthStore();

  const handleRegister = async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await authApi.register({
        phone,
        firstName,
        lastName,
        email: email || undefined,
        role,
        countryCode: countryCode ?? 'GY',
      });
      const access = data.data.tokens.accessToken;
      setAuth(data.data.user, access, data.data.tokens.refreshToken);
      if (role === 'CUSTOMER' && referral.trim()) {
        try {
          await customerApi.redeemReferral(referral.trim(), access);
        } catch {
          Alert.alert('Account created', 'We couldn’t apply that referral code, but your account is ready.');
        }
      }
    } catch {
      setError(true);
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 justify-center px-lg">
        <Heading size="xl" className="text-center">
          Create your account
        </Heading>
        <Text className="mb-xl mt-xs text-center text-text-secondary">Almost there — tell us your name.</Text>
        <Field label="First name" value={firstName} onChangeText={setFirstName} autoFocus />
        <Field label="Last name" value={lastName} onChangeText={setLastName} />
        <Field
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {role === 'CUSTOMER' ? (
          <Field
            label="Referral code (optional)"
            value={referral}
            onChangeText={setReferral}
            autoCapitalize="characters"
            autoCorrect={false}
          />
        ) : null}
        {error ? <Text className="mb-sm text-center text-sm text-error">Couldn&apos;t create your account. Try again.</Text> : null}
        <Button
          label="Create account"
          loading={loading}
          disabled={!firstName || !lastName}
          onPress={handleRegister}
        />
      </View>
    </SafeAreaView>
  );
}
