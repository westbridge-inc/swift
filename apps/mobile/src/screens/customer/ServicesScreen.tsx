import { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Badge, Skeleton } from '../../components/ui';
import { useServiceProviders, useRequestJob } from '../../hooks';

const TRADES = [
  'Electrician',
  'Plumber',
  'Carpenter',
  'Cleaner',
  'AC Repair',
  'Mechanic',
  'Painter',
  'Mason',
  'Welder',
  'Gardener',
];

function Header({ navigation }: any) {
  return (
    <View className="flex-row items-center px-lg py-sm">
      <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
        <Feather name="chevron-left" size={24} color={color.text.primary} />
      </Pressable>
      <Text className="ml-md text-base font-bold">Services</Text>
    </View>
  );
}

export function ServicesScreen({ navigation }: any) {
  const [trade, setTrade] = useState<string | undefined>(undefined);
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [sent, setSent] = useState(false);

  const { data, isFetching, isError } = useServiceProviders<any>(trade);
  const requestJob = useRequestJob();

  const providers: any[] = data?.providers ?? [];
  const canSend = !!selectedProviderId && description.trim().length >= 10;
  const errMsg = (requestJob.error as any)?.response?.data?.message;

  const onSend = () => {
    if (!selectedProviderId || description.trim().length < 10) return;
    requestJob.mutate(
      { providerId: selectedProviderId, description: description.trim() },
      {
        onSuccess: () => {
          setSent(true);
          setSelectedProviderId(undefined);
          setDescription('');
        },
      },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header navigation={navigation} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: selectedProviderId ? 240 : 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-lg pt-sm">
          <Heading size="2xl" className="mb-sm">
            Hire a pro
          </Heading>
          <Text className="mb-md text-sm text-text-secondary">
            Verified tradespeople. Quote in chat, pay cash on completion.
          </Text>

          <View className="flex-row flex-wrap" style={{ gap: 8 }}>
            {TRADES.map((t) => {
              const active = t === trade;
              return (
                <Pressable
                  key={t}
                  onPress={() => {
                    setTrade(t);
                    setSelectedProviderId(undefined);
                    setSent(false);
                  }}
                  className={
                    active
                      ? 'rounded-full border border-brand-500 bg-brand-500 px-lg py-sm'
                      : 'rounded-full border border-border-subtle px-lg py-sm'
                  }
                >
                  <Text className={active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'}>
                    {t}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {sent ? (
            <Card className="mt-lg bg-brand-50">
              <View className="flex-row items-center">
                <Feather name="check-circle" size={16} color={color.success} />
                <Text className="ml-sm font-semibold text-brand-700">Request sent</Text>
              </View>
              <Text className="mt-xs text-sm text-text-secondary">
                The provider will send a quote in chat. Pay cash on completion.
              </Text>
            </Card>
          ) : null}

          {trade && data?.guidance ? (
            <View className="mt-lg flex-row items-start rounded-2xl bg-brand-50 px-lg py-md">
              <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
              <Text className="ml-sm flex-1 text-sm text-brand-700">{data.guidance}</Text>
            </View>
          ) : null}

          {!trade ? (
            <Text className="mt-2xl text-center text-text-secondary">Pick a service to see verified pros near you.</Text>
          ) : isFetching ? (
            <View className="mt-lg">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="mb-md h-20 w-full" />
              ))}
            </View>
          ) : isError ? (
            <Text className="mt-lg text-text-secondary">Couldn&apos;t load providers. Try again.</Text>
          ) : providers.length === 0 ? (
            <Text className="mt-2xl text-center text-text-secondary">
              No {trade.toLowerCase()}s available yet — check back soon.
            </Text>
          ) : (
            <View className="mt-lg">
              {providers.map((p) => {
                const selected = p.id === selectedProviderId;
                return (
                  <Card key={p.id} className={selected ? 'mb-md border-brand-500' : 'mb-md'}>
                    <View className="flex-row items-start justify-between">
                      <View className="flex-1 pr-md">
                        <View className="flex-row items-center">
                          <Text className="text-base font-semibold">{p.certified ? `Certified ${p.trade}` : p.trade}</Text>
                          {p.certified ? <Badge label="Licensed" tone="success" className="ml-sm" /> : null}
                        </View>
                        <Text className="mt-xs text-sm text-text-secondary">
                          {p.totalRatings > 0 ? `${Number(p.averageRating).toFixed(1)} ★ (${p.totalRatings})` : 'New'}
                          {p.selfSkilled ? ' · Self-skilled' : ''}
                        </Text>
                        {p.bio ? (
                          <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>
                            {p.bio}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => setSelectedProviderId(selected ? undefined : p.id)}
                        className={
                          selected ? 'rounded-full bg-brand-500 px-lg py-sm' : 'rounded-full border border-brand-500 px-lg py-sm'
                        }
                      >
                        <Text className={selected ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-brand-500'}>
                          {selected ? 'Selected' : 'Request'}
                        </Text>
                      </Pressable>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      {selectedProviderId ? (
        <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Describe the job (at least 10 characters)…"
            placeholderTextColor={color.text.muted}
            multiline
            className="mb-sm rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
            style={{ minHeight: 64 }}
          />
          {errMsg ? <Text className="mb-sm text-center text-sm text-error">{errMsg}</Text> : null}
          <Button disabled={!canSend || requestJob.isPending} onPress={onSend}>
            <Text className="font-body font-semibold text-white">{requestJob.isPending ? 'Sending…' : 'Send request'}</Text>
          </Button>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
