import { useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Text, Heading, Card, Button, Badge } from '../../components/ui';
import { useUploadFile, useSubmitIdentity } from '../../hooks/verification';

function UploadRow({
  title,
  done,
  busy,
  onPress,
}: {
  title: string;
  done: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable disabled={busy} onPress={onPress}>
      <Card className={done ? 'mb-sm border-brand-500' : 'mb-sm'}>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-md">
            <Text className="text-xs text-text-secondary">{done ? 'Uploaded' : 'Get started'}</Text>
            <Text className="text-base font-semibold">{title}</Text>
          </View>
          {busy ? <ActivityIndicator /> : done ? <Badge label="Done" tone="success" /> : <Text className="text-xl text-brand-500">›</Text>}
        </View>
      </Card>
    </Pressable>
  );
}

export function IdentityVerificationScreen({ navigation }: any) {
  const upload = useUploadFile();
  const submit = useSubmitIdentity();
  const [idUrl, setIdUrl] = useState<string | undefined>(undefined);
  const [selfieUrl, setSelfieUrl] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState<'id' | 'selfie' | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const pick = async (kind: 'id' | 'selfie') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setPicking(kind);
    try {
      const url = await upload.mutateAsync({ uri: a.uri, name: a.fileName ?? `${kind}.jpg`, type: a.mimeType ?? 'image/jpeg' });
      if (kind === 'id') setIdUrl(url);
      else setSelfieUrl(url);
    } catch {
      // surfaced below
    } finally {
      setPicking(null);
    }
  };

  if (submitted) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center px-2xl">
          <Text className="text-5xl">🪪</Text>
          <Heading size="lg" className="mt-md text-center">
            ID submitted for review
          </Heading>
          <Text className="mt-xs text-center text-text-secondary">
            We verify within 24 hours. Once approved, the order limit is lifted for good.
          </Text>
          <Button label="Done" className="mt-xl px-2xl" onPress={() => navigation?.goBack?.()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Text className="text-2xl">‹ Back</Text>
        </Pressable>
        <Text className="ml-md text-base font-semibold">Verify your identity</Text>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Text className="mb-md text-sm text-text-secondary">
          A one-time check, required for larger cash orders and rides. Upload a government ID and a selfie — verify once and the limit is gone.
        </Text>
        <UploadRow title="Government ID" done={!!idUrl} busy={picking === 'id'} onPress={() => pick('id')} />
        <UploadRow title="Selfie" done={!!selfieUrl} busy={picking === 'selfie'} onPress={() => pick('selfie')} />

        {submit.isError ? <Text className="mt-sm text-center text-sm text-error">Couldn&apos;t submit. Please try again.</Text> : null}

        <Button
          label={submit.isPending ? 'Submitting…' : 'Submit for verification'}
          className="mt-lg"
          disabled={!idUrl || !selfieUrl || submit.isPending}
          onPress={() =>
            submit.mutate({ idDocumentUrl: idUrl as string, selfieUrl: selfieUrl as string }, { onSuccess: () => setSubmitted(true) })
          }
        />
        <Text className="mt-md text-center text-xs text-text-muted">
          Your documents are encrypted and only used for verification (DPA 2023).
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
