import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, SafeAreaView } from 'react-native';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { SWIFT_ORANGE, SWIFT_BLACK } from '../../theme/colors';

export function OtpVerificationScreen({ route, navigation }: any) {
  const { phone } = route.params;
  const [otp, setOtp] = useState('');
  const { setAuth } = useAuthStore();

  const handleVerify = async (code: string) => {
    if (code.length !== 6) return;
    try {
      const { data } = await authApi.verifyOtp(phone, code);
      if (data.data.isNewUser) {
        navigation.navigate('Register', { phone });
      } else {
        setAuth(data.data.user, data.data.tokens.accessToken, data.data.tokens.refreshToken);
      }
    } catch (err) {
      // Handle error
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Enter the code</Text>
        <Text style={styles.subtitle}>Sent to {phone}</Text>
        <TextInput
          style={styles.otpInput}
          placeholder="000000"
          placeholderTextColor="#38383A"
          keyboardType="number-pad"
          maxLength={6}
          value={otp}
          onChangeText={(text) => {
            setOtp(text);
            if (text.length === 6) handleVerify(text);
          }}
          autoFocus
          textAlign="center"
        />
        <Text style={styles.resend}>Resend code in 60s</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#8E8E93', textAlign: 'center', marginTop: 8, marginBottom: 40 },
  otpInput: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 20, color: '#FFF', fontSize: 32, letterSpacing: 16, fontWeight: '700' },
  resend: { color: SWIFT_ORANGE, textAlign: 'center', marginTop: 24, fontSize: 14 },
});
