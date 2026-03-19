import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { authApi } from '../../services/api';
import { SWIFT_ORANGE, SWIFT_BLACK } from '../../theme/colors';

export function PhoneEntryScreen({ navigation }: any) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSendOtp = async () => {
    setLoading(true);
    try {
      await authApi.sendOtp(`+592${phone}`);
      navigation.navigate('OtpVerification', { phone: `+592${phone}` });
    } catch (err) {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.logo}>swift</Text>
        <Text style={styles.title}>Enter your phone number</Text>
        <Text style={styles.subtitle}>We'll send you a verification code</Text>
        <View style={styles.inputRow}>
          <View style={styles.countryCode}>
            <Text style={styles.countryCodeText}>+592</Text>
          </View>
          <TextInput
            style={styles.input}
            placeholder="Phone number"
            placeholderTextColor="#8E8E93"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
            autoFocus
          />
        </View>
        <TouchableOpacity
          style={[styles.button, !phone && styles.buttonDisabled]}
          onPress={handleSendOtp}
          disabled={!phone || loading}
        >
          <Text style={styles.buttonText}>{loading ? 'Sending...' : 'Continue'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  logo: { fontSize: 48, fontWeight: '700', color: SWIFT_ORANGE, textAlign: 'center', marginBottom: 40 },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#8E8E93', textAlign: 'center', marginTop: 8, marginBottom: 32 },
  inputRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  countryCode: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 16, justifyContent: 'center' },
  countryCodeText: { color: '#FFF', fontSize: 16 },
  input: { flex: 1, backgroundColor: '#1C1C1E', borderRadius: 12, padding: 16, color: '#FFF', fontSize: 18 },
  button: { backgroundColor: SWIFT_ORANGE, borderRadius: 12, padding: 18, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
});
