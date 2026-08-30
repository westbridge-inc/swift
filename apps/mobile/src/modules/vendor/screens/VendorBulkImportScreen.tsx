import { useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { Feather } from '@expo/vector-icons';
import { color, font, fontSize, radius, space } from '@swift/ui';
import { Card, PillButton, T } from '../../../kit';
import { PressableScale } from '../../../kit/pressable-scale';
import { toast } from '../../../kit/toast';
import { useImportAutomap, useImportItems, useImportFile } from '../../../hooks/vendorops';
import {
  AuthSessionBoundaryError,
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
} from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import type { AuthSessionSnapshot } from '../../../lib/authSession';
import { useVendorPreview } from '../../../stores/vendorPreview';

const RECOMMENDED = 'category, name, basePrice, sku, unit, stockQuantity, description';

export function VendorBulkImportScreen({ navigation }: any) {
  const previewType = useVendorPreview((state) => state.previewType);
  const automap = useImportAutomap();
  const importFile = useImportFile();
  const importItems = useImportItems();
  const [csv, setCsv] = useState('');
  const [importScope, setImportScope] = useState<{
    authSession: AuthSessionSnapshot;
    storeId: string | null;
  } | null>(null);
  // CSV-paste and file uploads land in the SAME confirm-ready preview shape.
  const mapped: any = importFile.data ?? automap.data;
  const result: any = importItems.data;

  const analyze = () => {
    if (csv.trim().length === 0) return;
    const authSession = getAuthSessionSnapshot();
    if (!authSession) return;
    const scope = {
      authSession,
      storeId: useStoreSwitcher.getState().selectedStoreId,
    };
    setImportScope(scope);
    importItems.reset();
    importFile.reset();
    automap.mutate({ csv: csv.trim(), ...scope });
  };

  const pickFile = async () => {
    const authSession = getAuthSessionSnapshot();
    if (!authSession) return;
    const scope = {
      authSession,
      storeId: useStoreSwitcher.getState().selectedStoreId,
    };
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: [
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/pdf',
        ],
        copyToCacheDirectory: true,
      });
      requireAuthSessionForPrincipal(scope.authSession);
      if (picked.canceled || !picked.assets?.[0]) return;
      const a = picked.assets[0];
      const name = a.name ?? 'catalogue';
      setImportScope(scope);
      importItems.reset();
      automap.reset();

      if (/\.xlsx$/i.test(name)) {
        importFile.mutate({
          kind: 'xlsx',
          file: {
            uri: a.uri,
            name,
            type: a.mimeType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
          ...scope,
        });
      } else if (/\.pdf$/i.test(name)) {
        importFile.mutate({
          kind: 'menu-pdf',
          file: { uri: a.uri, name, type: 'application/pdf' },
          ...scope,
        });
      } else {
        // CSV: read the text and reuse the paste path.
        importFile.reset();
        const text = await (await fetch(a.uri)).text();
        requireAuthSessionForPrincipal(scope.authSession);
        setCsv(text);
        automap.mutate({ csv: text.trim(), ...scope });
      }
    } catch (pickError) {
      if (pickError instanceof AuthSessionBoundaryError) return;
      // Tell the vendor instead of silently accepting a file that didn't load.
      toast.error('Couldn’t read that file', 'Paste the rows below instead, or try a different file.');
    }
  };

  const runImport = () => {
    const authSession = importScope?.authSession ?? getAuthSessionSnapshot();
    if (!authSession) return;
    const scope = importScope ?? {
      authSession,
      storeId: useStoreSwitcher.getState().selectedStoreId,
    };
    requireAuthSessionForPrincipal(scope.authSession);
    setImportScope(scope);
    importItems.mutate({ csv: mapped?.normalizedCsv ?? csv.trim(), ...scope });
  };

  const busy = automap.isPending || importFile.isPending;
  const errMsg =
    (importFile.error as any)?.response?.data?.error?.message ??
    (automap.error as any)?.response?.data?.error?.message;

  const importedCount = result?.imported ?? result?.created ?? result?.successCount ?? null;
  const failedCount = result?.failed ?? result?.errors?.length ?? result?.failedCount ?? 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <T variant="body" weight="bold" style={{ marginLeft: space.md }}>Bulk import</T>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <T variant="label" tone="muted" style={{ marginBottom: space.sm }}>
          Bring your whole catalogue at once: a CSV or Excel export from your spreadsheet, or a
          PDF menu we turn into draft items for you to confirm. Recommended columns: {RECOMMENDED}.
        </T>

        {previewType ? (
          <Card style={{ marginBottom: space.md }}>
            <T variant="label" weight="semibold">Read-only preview</T>
            <T variant="micro" tone="muted" style={{ marginTop: space.xs }}>
              Sign in and create your store before importing a catalogue.
            </T>
          </Card>
        ) : null}

        <PillButton
          label="Pick a file (CSV, Excel, or PDF menu)"
          loading={importFile.isPending}
          disabled={!!previewType}
          onPress={pickFile}
        />

        <T variant="micro" tone="muted" center style={{ marginVertical: space.md }}>— or paste CSV —</T>

        <TextInput
          value={csv}
          onChangeText={setCsv}
          placeholder={'category,name,basePrice,stockQuantity\nDrinks,Cola 1L,400,50\nDrinks,Water 500ml,200,120'}
          placeholderTextColor={color.text.muted}
          multiline
          editable={!previewType}
          textAlignVertical="top"
          style={{
            minHeight: 140,
            marginBottom: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: color.border.subtle,
            backgroundColor: color.surface.base,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            // [Wave 3] The one input in the app with NO fontFamily — it fell
            // back to the system font. Token face now.
            fontFamily: font.body,
            fontSize: fontSize.sm,
            color: color.text.primary,
          }}
        />
        {/* [#947's grammar] Disabled says the ask. */}
        <PillButton
          label={csv.trim().length === 0 ? 'Paste your rows first' : 'Analyze CSV'}
          variant="outline"
          loading={automap.isPending}
          disabled={!!previewType || csv.trim().length === 0 || busy}
          onPress={analyze}
        />

        {errMsg ? <T variant="label" tone="error" style={{ marginTop: space.sm }}>{errMsg}</T> : null}

        {mapped ? (
          <Card style={{ marginTop: space.md }}>
            <T variant="body" weight="semibold">
              {mapped.rowCount} item{mapped.rowCount === 1 ? '' : 's'} found
              {mapped.source === 'menu-pdf' ? ' in your menu' : ''}
            </T>
            {mapped.mapping ? (
              <T variant="micro" tone="muted" style={{ marginTop: space.xs }}>
                Mapped: {Object.entries(mapped.mapping ?? {}).map(([k, v]) => `${v}→${k}`).join(', ')}
              </T>
            ) : (
              <T variant="micro" tone="muted" style={{ marginTop: space.xs }}>
                Check the names and prices below — nothing imports until you confirm.
              </T>
            )}
            {(mapped.preview ?? []).slice(0, 5).map((r: any, i: number) => (
              <View key={i} style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: color.border.subtle, paddingTop: space.sm }}>
                <T variant="label" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
                  {r.name ?? '—'}
                </T>
                <T variant="label" tone="muted">
                  {r.basePrice ?? r.price ?? ''}
                  {r.stockQuantity != null && r.stockQuantity !== '' ? ` · ${r.stockQuantity} stock` : ''}
                </T>
              </View>
            ))}
            <PillButton
              label={`Import ${mapped.rowCount} items`}
              style={{ marginTop: space.md }}
              loading={importItems.isPending}
              disabled={!!previewType}
              onPress={runImport}
            />
          </Card>
        ) : null}

        {result ? (
          <Card style={{ marginTop: space.md, borderWidth: 1, borderColor: color.brand[500] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Feather name="check-circle" size={18} color={color.success} />
              <T variant="body" weight="semibold" style={{ marginLeft: space.sm }}>Import complete</T>
            </View>
            <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
              {importedCount != null ? `${importedCount} imported` : 'Items imported'}
              {failedCount ? ` · ${failedCount} skipped` : ''}.
            </T>
            <PillButton label="Back to menu" variant="outline" style={{ marginTop: space.md }} onPress={() => navigation?.goBack?.()} />
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
