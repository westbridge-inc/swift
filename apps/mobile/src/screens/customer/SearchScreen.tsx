import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TextInput } from 'react-native';
import { SWIFT_BLACK } from '../../theme/colors';

export function SearchScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Search</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Restaurants, groceries, dishes..."
          placeholderTextColor="#636366"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SWIFT_BLACK },
  content: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#FFF', marginBottom: 16 },
  searchInput: { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 14, color: '#FFF', fontSize: 16 },
});
