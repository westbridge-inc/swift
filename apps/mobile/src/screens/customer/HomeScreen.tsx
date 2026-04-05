import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity } from 'react-native';
import { useLocationStore } from '../../stores/locationStore';
import { SWIFT_ORANGE, SWIFT_BLACK } from '../../theme/colors';

const SERVICE_CATEGORIES = [
  { key: 'food', label: 'Food', icon: '🍔', color: '#FF6B00' },
  { key: 'grocery', label: 'Grocery', icon: '🛒', color: '#34C759' },
  { key: 'courier', label: 'Send', icon: '📦', color: '#007AFF' },
  { key: 'ride', label: 'Ride', icon: '🚗', color: '#AF52DE' },
];

export function HomeScreen({ _navigation }: any) {
  const { address } = useLocationStore();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.deliverTo}>Deliver to</Text>
          <TouchableOpacity style={styles.addressRow}>
            <Text style={styles.address} numberOfLines={1}>
              {address || 'Set your location'}
            </Text>
            <Text style={styles.chevron}>{'>'}</Text>
          </TouchableOpacity>
        </View>

        {/* Brand */}
        <Text style={styles.brand}>swift</Text>
        <Text style={styles.tagline}>Everything delivered.</Text>

        {/* Service Categories */}
        <View style={styles.categories}>
          {SERVICE_CATEGORIES.map((cat) => (
            <TouchableOpacity key={cat.key} style={styles.categoryBubble} activeOpacity={0.7}>
              <View style={[styles.categoryIcon, { backgroundColor: cat.color + '20' }]}>
                <Text style={styles.categoryEmoji}>{cat.icon}</Text>
              </View>
              <Text style={styles.categoryLabel}>{cat.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Vendor List Placeholder */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Near You</Text>
          <View style={styles.vendorPlaceholder}>
            <Text style={styles.placeholderText}>Vendors will appear here</Text>
          </View>
          <View style={styles.vendorPlaceholder}>
            <Text style={styles.placeholderText}>Pull to refresh</Text>
          </View>
        </View>

        {/* Promotions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Promotions</Text>
          <View style={styles.promoBanner}>
            <Text style={styles.promoTitle}>Free delivery</Text>
            <Text style={styles.promoSubtitle}>On your first order</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  scrollView: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 12 },
  deliverTo: { color: '#8E8E93', fontSize: 12, fontWeight: '500' },
  addressRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  address: { color: '#FFF', fontSize: 16, fontWeight: '600', flex: 1 },
  chevron: { color: '#8E8E93', fontSize: 16, marginLeft: 8 },
  brand: { fontSize: 36, fontWeight: '700', color: SWIFT_ORANGE, paddingHorizontal: 16, marginTop: 24 },
  tagline: { fontSize: 16, color: '#8E8E93', paddingHorizontal: 16, marginTop: 4 },
  categories: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 16, marginTop: 28, marginBottom: 8 },
  categoryBubble: { alignItems: 'center', gap: 8 },
  categoryIcon: { width: 64, height: 64, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  categoryEmoji: { fontSize: 28 },
  categoryLabel: { color: '#FFF', fontSize: 13, fontWeight: '500' },
  section: { paddingHorizontal: 16, marginTop: 28 },
  sectionTitle: { color: '#FFF', fontSize: 20, fontWeight: '700', marginBottom: 16 },
  vendorPlaceholder: { backgroundColor: '#1C1C1E', borderRadius: 16, height: 180, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  placeholderText: { color: '#636366', fontSize: 14 },
  promoBanner: { backgroundColor: '#1C1C1E', borderRadius: 16, padding: 20, borderLeftWidth: 4, borderLeftColor: SWIFT_ORANGE },
  promoTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  promoSubtitle: { color: '#8E8E93', fontSize: 14, marginTop: 4 },
});
