import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { SWIFT_BLACK } from '../../theme/colors';

export function OrdersScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Your Orders</Text>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No orders yet</Text>
          <Text style={styles.emptySubtext}>Your order history will appear here</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  emptySubtext: { color: '#8E8E93', fontSize: 14, marginTop: 8 },
});
