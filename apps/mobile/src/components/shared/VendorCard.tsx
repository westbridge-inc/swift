import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import type { Vendor } from '@swift/types';

interface VendorCardProps {
  vendor: Vendor;
  onPress: () => void;
}

export function VendorCard({ vendor, onPress }: VendorCardProps) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.imageContainer}>
        {vendor.coverImageUrl ? (
          <Image source={{ uri: vendor.coverImageUrl }} style={styles.image} />
        ) : (
          <View style={[styles.image, styles.placeholder]} />
        )}
        {vendor.isFeatured && (
          <View style={styles.featuredBadge}>
            <Text style={styles.featuredText}>Promoted</Text>
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={styles.name}>{vendor.name}</Text>
        <Text style={styles.meta}>
          {vendor.averageRating.toFixed(1)} · {vendor.estimatedPrepTime}-{vendor.estimatedPrepTime + 10} min
        </Text>
        <Text style={styles.cuisines}>{vendor.cuisineTypes.join(' · ')}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#1C1C1E', borderRadius: 16, marginBottom: 16, overflow: 'hidden' },
  imageContainer: { position: 'relative' },
  image: { width: '100%', height: 160 },
  placeholder: { backgroundColor: '#2C2C2E' },
  featuredBadge: { position: 'absolute', top: 12, left: 12, backgroundColor: '#FF6B00', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  featuredText: { color: '#FFF', fontSize: 11, fontWeight: '600' },
  info: { padding: 12 },
  name: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  meta: { color: '#8E8E93', fontSize: 14, marginTop: 4 },
  cuisines: { color: '#636366', fontSize: 12, marginTop: 4 },
});
