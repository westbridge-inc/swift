import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Card, LinkText, T } from '../kit';
import { servicesApi } from '../services/api';
import { storePhotoUrl } from '../lib/images';
import { prepareUploadImage } from '../lib/uploadImage';

/** The API's limit (services.routes PORTFOLIO_MAX). */
const PORTFOLIO_MAX = 12;

/**
 * [IMAGES-E2E] Photos of a service provider's own work. Customers see them on the
 * provider's card once the provider is verified. Each photo is sized on the phone;
 * then the server scans it, redraws it WITHOUT the camera's data (location, device,
 * time) and keeps it where the apps load it.
 */
export function ProviderPortfolioCard({ photos }: { photos: string[] }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['services', 'provider-me'] });
  const serverWords = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? fallback;

  const upload = useMutation({
    mutationFn: async (file: { uri: string; name: string; type: string }) => {
      const prepared = await prepareUploadImage(file);
      const form = new FormData();
      form.append('file', { uri: prepared.uri, name: prepared.name, type: prepared.type } as unknown as Blob);
      return servicesApi.uploadPortfolioPhoto(form);
    },
    onMutate: () => setError(null),
    onSuccess: () => { void refresh(); },
    onError: (e: unknown) => setError(serverWords(e, "That photo didn't upload. Check your connection and try again.")),
  });
  const remove = useMutation({
    mutationFn: (photo: string) => servicesApi.removePortfolioPhoto(photo.split('/').pop() ?? photo),
    onMutate: () => setError(null),
    onSuccess: () => { void refresh(); },
    onError: (e: unknown) => setError(serverWords(e, "That photo couldn't be removed. Try again.")),
  });

  const pick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library access needed. Allow it in Settings to choose a photo.');
      return;
    }
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    upload.mutate({ uri: a.uri, name: a.fileName ?? 'work.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  const full = photos.length >= PORTFOLIO_MAX;
  return (
    <Card>
      <T variant="label" weight="semibold">Photos of your work</T>
      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
        Customers see these on your card once you are verified. Location and camera details are removed. Up to {PORTFOLIO_MAX}.
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
        {photos.map((photo) => {
          const uri = storePhotoUrl(photo, 320);
          return (
            <View key={photo} style={{ width: 88, height: 66, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.surface.subtle }}>
              {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel="Photo of your work" /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove this photo"
                disabled={remove.isPending}
                onPress={() => remove.mutate(photo)}
                hitSlop={8}
                style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.scrim }}
              >
                <Feather name="x" size={14} color={color.white} />
              </Pressable>
            </View>
          );
        })}
      </View>
      <View style={{ marginTop: space.md }}>
        {full ? (
          <T variant="caption" tone="muted">Your portfolio is full. Remove a photo to add another.</T>
        ) : (
          <LinkText label={upload.isPending ? 'Uploading…' : 'Add a photo'} onPress={upload.isPending ? undefined : () => { void pick(); }} />
        )}
      </View>
      {error ? <T variant="caption" tone="error" style={{ marginTop: space.sm }}>{error}</T> : null}
    </Card>
  );
}
