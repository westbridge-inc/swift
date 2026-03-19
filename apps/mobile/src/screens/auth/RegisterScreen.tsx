import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { SWIFT_ORANGE, SWIFT_BLACK } from '../../theme/colors';

export function RegisterScreen({ route }: any) {
  const { phone } = route.params;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();

  const handleRegister = async () => {
    setLoading(true);
    try {
      const { data } = await authApi.register({ phone, firstName, lastName, email: email || undefined });
      setAuth(data.data.user, data.data.tokens.accessToken, data.data.tokens.refreshToken);
    } catch (err) {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>Almost there! Tell us your name.</Text>
        <TextInput style={styles.input} placeholder="First name" placeholderTextColor="#8E8E93" value={firstName} onChangeText={setFirstName} autoFocus />
        <TextInput style={styles.input} placeholder="Last name" placeholderTextColor="#8E8E93" value={lastName} onChangeText={setLastName} />
        <TextInput style={styles.input} placeholder="Email (optional)" placeholderTextColor="#8E8E93" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TouchableOpacity style={[styles.button, (!firstName || !lastName) && styles.buttonDisabled]} onPress={handleRegister} disabled={!firstName || !lastName || loading}>
          <Text style={styles.buttonText}>{loading ? 'Creating...' : 'Create Account'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#8E8E93', textAlign: 'center', marginTop: 8, marginBottom: 32 },
  input: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 16, color: '#FFF', fontSize: 16, marginBottom: 16 },
  button: { backgroundColor: SWIFT_ORANGE, borderRadius: 12, padding: 18, alignItems: 'center', marginTop: 8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
});
