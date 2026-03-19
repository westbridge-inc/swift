import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { SWIFT_BLACK } from '../../theme/colors';

export function AvailableOrdersScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Available Orders</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF' },
});
