import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity } from 'react-native';
import { useAuthStore } from '../../stores/authStore';
import { SWIFT_BLACK, SWIFT_ORANGE } from '../../theme/colors';

export function AccountScreen() {
  const { user, logout } = useAuthStore();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Account</Text>

        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user?.firstName?.[0] || '?'}{user?.lastName?.[0] || ''}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name}>{user?.firstName} {user?.lastName}</Text>
            <Text style={styles.phone}>{user?.phone}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.menuItem}>
          <Text style={styles.menuText}>Edit Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Text style={styles.menuText}>Saved Addresses</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Text style={styles.menuText}>Payment Methods</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Text style={styles.menuText}>Notifications</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Text style={styles.menuText}>Help & Support</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.logoutButton} onPress={logout}>
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF', marginBottom: 24 },
  profileCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1E', borderRadius: 16, padding: 16, marginBottom: 24 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: SWIFT_ORANGE, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontSize: 20, fontWeight: '700' },
  profileInfo: { marginLeft: 16 },
  name: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  phone: { color: '#8E8E93', fontSize: 14, marginTop: 4 },
  menuItem: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 16, marginBottom: 8 },
  menuText: { color: '#FFF', fontSize: 16 },
  logoutButton: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 16, marginTop: 16, alignItems: 'center' },
  logoutText: { color: '#FF453A', fontSize: 16, fontWeight: '600' },
});
