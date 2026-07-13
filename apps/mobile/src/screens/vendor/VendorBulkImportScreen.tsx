import { useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Button, PressableScale } from '../../components/ui';
import { toast } from '../../components/ui/toast';
import { useImportAutomap, useImportItems, useImportFile } from '../../hooks/vendorops';

const RECOMMENDED = 'category, name, basePrice, sku, unit, stockQuantity, description';

export function VendorBulkImportScreen({ navigation }: any) {
  const automap = useImportAutomap();
  const importFile = useImportFile();
  const importItems = useImportItems();
  const [csv, setCsv] = useState('');
  // CSV-paste and file uploads land in the SAME confirm-ready preview shape.
  const mapped: any = importFile.data ?? automap.data;
  const result: any = importItems.data;

  const analyze = () => {
    if (csv.trim().length === 0) return;
    importItems.reset();
    importFile.reset();
    automap.mutate(csv.trim());
  };

  const pickFile = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: [
        'text/csv',
        'text/comma-separated-values',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/pdf',
      ],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    const a = picked.assets[0];
    const name = a.name ?? 'catalogue';
    importItems.reset();
    automap.reset();

    if (/\.xlsx$/i.test(name)) {
      importFile.mutate({ kind: 'xlsx', file: { uri: a.uri, name, type: a.mimeType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    } else if (/\.pdf$/i.test(name)) {
      importFile.mutate({ kind: 'menu-pdf', file: { uri: a.uri, name, type: 'application/pdf' } });
    } else {
      // CSV: read the text and reuse the paste path
      importFile.reset();
      try {
        const text = await (await fetch(a.uri)).text();
        setCsv(text);
        automap.mutate(text.trim());
      } catch {
        // Tell the vendor instead of silently accepting a file that didn't load.
        toast.error('Couldn’t read that file', 'Paste the rows below instead, or try a different file.');
      }
    }
  };

  const runImport = () => {
    importItems.mutate(mapped?.normalizedCsv ?? csv.trim());
  };

  const busy = automap.isPending || importFile.isPending;
  const errMsg =
    (importFile.error as any)?.response?.data?.error?.message ??
    (automap.error as any)?.response?.data?.error?.message;

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
          Bring your whole catalogue at once: a CSV or Excel export from your spreadsheet, or a
          PDF menu we turn into draft items for you to confirm. Recommended columns: {RECOMMENDED}.
        </Text>

        <Button label="Pick a file (CSV, Excel, or PDF menu)" loading={importFile.isPending} onPress={pickFile} />

        <Text className="my-md text-center text-xs text-text-muted">— or paste CSV —</Text>

        <TextInput
          value={csv}
          onChangeText={setCsv}
          placeholder={'category,name,basePrice,stockQuantity\nDrinks,Cola 1L,400,50\nDrinks,Water 500ml,200,120'}
          placeholderTextColor={color.text.muted}
          multiline
          textAlignVertical="top"
          style={{ minHeight: 140 }}
          className="mb-md rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-sm text-text-primary"
        />
        <Button
          label="Analyze CSV"
          variant="outline"
          loading={automap.isPending}
          disabled={csv.trim().length === 0 || busy}
          onPress={analyze}
        />

        {errMsg ? <Text className="mt-sm text-sm text-error">{errMsg}</Text> : null}

        {mapped ? (
          <Card className="mt-md">
            <Text className="text-base font-semibold">
              {mapped.rowCount} item{mapped.rowCount === 1 ? '' : 's'} found
              {mapped.source === 'menu-pdf' ? ' in your menu' : ''}
            </Text>
            {mapped.mapping ? (
              <Text className="mt-xs text-xs text-text-muted">
                Mapped: {Object.entries(mapped.mapping ?? {}).map(([k, v]) => `${v}→${k}`).join(', ')}
              </Text>
            ) : (
              <Text className="mt-xs text-xs text-text-muted">
                Check the names and prices below — nothing imports until you confirm.
              </Text>
            )}
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
          <Card className="mt-md" style={{ borderColor: color.brand[500] }}>
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
