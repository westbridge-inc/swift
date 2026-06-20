import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, Button, Field } from '../../components/ui';

export function RegisterScreen({ route }: any) {
  const phone = route?.params?.phone;
  const role = (route?.params?.role ?? 'CUSTOMER') as 'CUSTOMER' | 'MOVER' | 'VENDOR';
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
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
      setAuth(data.data.user, data.data.tokens.accessToken, data.data.tokens.refreshToken);
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
