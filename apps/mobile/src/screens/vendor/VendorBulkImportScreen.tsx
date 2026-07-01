import { useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Button, PressableScale } from '../../components/ui';
import { useImportAutomap, useImportItems } from '../../hooks/vendorops';

const RECOMMENDED = 'category, name, basePrice, sku, unit, stockQuantity, description';

export function VendorBulkImportScreen({ navigation }: any) {
  const automap = useImportAutomap();
  const importItems = useImportItems();
  const [csv, setCsv] = useState('');
  const mapped: any = automap.data;
  const result: any = importItems.data;

  const analyze = () => {
    if (csv.trim().length === 0) return;
    importItems.reset();
    automap.mutate(csv.trim());
  };
  const runImport = () => {
    importItems.mutate(mapped?.normalizedCsv ?? csv.trim());
  };

  const importedCount = result?.imported ?? result?.created ?? result?.successCount ?? null;
  const failedCount = result?.failed ?? result?.errors?.length ?? result?.failedCount ?? 0;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold text-text-primary">Bulk import</Text>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="mb-sm text-sm text-text-secondary">
          Paste your catalogue from a spreadsheet (CSV). We&apos;ll match your columns automatically — no need to
          rename anything. Recommended columns: {RECOMMENDED}.
        </Text>
        <TextInput
          value={csv}
          onChangeText={setCsv}
          placeholder={'category,name,basePrice,stockQuantity\nDrinks,Cola 1L,400,50\nDrinks,Water 500ml,200,120'}
          placeholderTextColor={color.text.muted}
          multiline
          textAlignVertical="top"
          style={{ minHeight: 160 }}
          className="mb-md rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-sm text-text-primary"
        />
        <Button
          label="Analyze CSV"
          variant="outline"
          loading={automap.isPending}
          disabled={csv.trim().length === 0}
          onPress={analyze}
        />

        {automap.isError ? (
          <Text className="mt-sm text-sm text-error">
            {(automap.error as any)?.response?.data?.error?.message ?? 'Couldn’t read that CSV. Check the columns and try again.'}
          </Text>
        ) : null}

        {mapped ? (
          <Card className="mt-md">
            <Text className="text-base font-semibold">
              {mapped.rowCount} item{mapped.rowCount === 1 ? '' : 's'} found
            </Text>
            <Text className="mt-xs text-xs text-text-muted">
              Mapped: {Object.entries(mapped.mapping ?? {}).map(([k, v]) => `${v}→${k}`).join(', ')}
            </Text>
            {(mapped.preview ?? []).slice(0, 5).map((r: any, i: number) => (
              <View key={i} className="mt-sm flex-row items-center justify-between border-t border-border-subtle pt-sm">
                <Text className="flex-1 pr-md text-sm" numberOfLines={1}>
                  {r.name ?? '—'}
                </Text>
                <Text className="text-sm text-text-secondary">
                  {r.basePrice ?? r.price ?? ''}
                  {r.stockQuantity != null && r.stockQuantity !== '' ? ` · ${r.stockQuantity} stock` : ''}
                </Text>
              </View>
            ))}
            <Button
              label={`Import ${mapped.rowCount} items`}
              className="mt-md"
              loading={importItems.isPending}
              onPress={runImport}
            />
          </Card>
        ) : null}

        {result ? (
          <Card className="mt-md border-brand-500">
            <View className="flex-row items-center">
              <Feather name="check-circle" size={18} color={color.success} />
              <Text className="ml-sm text-base font-semibold">Import complete</Text>
            </View>
            <Text className="mt-xs text-sm text-text-secondary">
              {importedCount != null ? `${importedCount} imported` : 'Items imported'}
              {failedCount ? ` · ${failedCount} skipped` : ''}.
            </Text>
            <Button label="Back to menu" variant="outline" className="mt-md" onPress={() => navigation?.goBack?.()} />
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
