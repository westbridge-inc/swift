import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useQueryClient } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Card, LinkText, T } from '../kit';
import { useVendorMutation } from '../hooks/useVendorMutation';
import { vendorApi } from '../services/api';
import { storePhotoUrl } from '../lib/images';
import { prepareUploadImage } from '../lib/uploadImage';

/**
 * [IMAGES-E2E] The store's own logo and cover photo (store managers).
 *
 * The photo is sized on the phone, then the server checks it is a photo,
 * scans it, redraws it WITHOUT the camera's data (location, device, time) and keeps
 * it where customers' apps and the website load it. The cover leads the store's page
 * and its card in every list; the logo sits beside the store's name.
 */
type Slot = 'logo' | 'cover';

const SLOTS: { slot: Slot; field: 'logoUrl' | 'coverImageUrl'; title: string; sub: string; aspect: [number, number] }[] = [
  { slot: 'cover', field: 'coverImageUrl', title: 'Cover photo', sub: 'Leads your store page and your card in lists', aspect: [16, 9] },
  { slot: 'logo', field: 'logoUrl', title: 'Logo', sub: 'Sits beside your store name', aspect: [1, 1] },
];

export function StorePhotosCard({ store }: { store: { logoUrl?: string | null; coverImageUrl?: string | null } }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Slot | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
  const serverWords = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? fallback;

  const upload = useVendorMutation({
    mutationFn: async ({ slot, file }: { slot: Slot; file: { uri: string; name: string; type: string } }) => {
      // Sized on the phone first (a smaller upload on a mobile network); the server redraws it anyway.
      const prepared = await prepareUploadImage(file);
      const form = new FormData();
      form.append('file', { uri: prepared.uri, name: prepared.name, type: prepared.type } as unknown as Blob);
      return vendorApi.uploadStorePhoto(slot, form);
    },
    onMutate: ({ slot }) => { setError(null); setBusy(slot); },
    onSuccess: () => { void refresh(); },
    onError: (e: unknown) => setError(serverWords(e, "That photo didn't upload. Check your connection and try again.")),
    onSettled: () => setBusy(null),
  });

  const remove = useVendorMutation({
    mutationFn: (slot: Slot) => vendorApi.removeStorePhoto(slot),
    onMutate: (slot) => { setError(null); setBusy(slot); },
    onSuccess: () => { void refresh(); },
    onError: (e: unknown) => setError(serverWords(e, "That photo couldn't be removed. Try again.")),
    onSettled: () => setBusy(null),
  });

  const pick = async (slot: Slot, aspect: [number, number]) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library access needed. Allow it in Settings to choose a photo.');
      return;
    }
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect,
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    upload.mutate({ slot, file: { uri: a.uri, name: a.fileName ?? `${slot}.jpg`, type: a.mimeType ?? 'image/jpeg' } });
  };

  return (
    <Card style={{ marginBottom: space.lg }}>
      <T variant="label" style={{ fontWeight: '700' }}>Store photos</T>
      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
        Customers see these in the app and on the website. Location and camera details are removed.
      </T>
      {SLOTS.map(({ slot, field, title, sub, aspect }) => {
        const current = store[field] ?? null;
        const uri = storePhotoUrl(current, 320);
        const working = busy === slot;
        // One photo request at a time: while either slot uploads or removes, no press on the card sends another.
        const sending = upload.isPending || remove.isPending;
        return (
          <View key={slot} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
            <View
              style={{
                width: slot === 'logo' ? 56 : 96,
                height: 56,
                borderRadius: slot === 'logo' ? 28 : radius.md,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.surface.subtle,
              }}
            >
              {uri ? (
                <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel={title} />
              ) : (
                <Feather name="image" size={20} color={color.text.muted} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <T variant="label">{title}</T>
              <T variant="caption" tone="muted" numberOfLines={2}>{sub}</T>
              <View style={{ flexDirection: 'row', gap: space.md, marginTop: 4 }}>
                <LinkText
                  label={working ? 'Working…' : current ? 'Change' : 'Add photo'}
                  onPress={sending ? undefined : () => { void pick(slot, aspect); }}
                />
                {current && !working ? <LinkText label="Remove" tone="muted" onPress={() => { if (remove.isPending || upload.isPending) return; remove.mutate(slot); }} /> : null}
              </View>
            </View>
          </View>
        );
      })}
      {error ? <T variant="caption" tone="error" style={{ marginTop: space.sm }}>{error}</T> : null}
    </Card>
  );
}
