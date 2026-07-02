import { useState } from 'react';
import { View, ScrollView, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Badge, Skeleton, PressableScale, EmptyState, ChoiceChip } from '../../../components/ui';
import { useServiceJobs, useScheduleJob, useCancelJob, useRateJob } from '../../../hooks';

const money = (n: number | string) => `$${Number(n).toLocaleString()} GYD`;

const STATUS_LABEL: Record<string, { label: string; tone: 'brand' | 'success' | 'neutral' }> = {
  REQUESTED: { label: 'Waiting for quote', tone: 'neutral' },
  QUOTED: { label: 'Quote received', tone: 'brand' },
  SCHEDULED: { label: 'Scheduled', tone: 'brand' },
  IN_PROGRESS: { label: 'In progress', tone: 'brand' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** Next 7 days as chips — no datetime-picker dependency needed. */
function upcomingDays(): Array<{ key: string; label: string; date: Date }> {
  const days: Array<{ key: string; label: string; date: Date }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    d.setSeconds(0, 0);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    days.push({ key: d.toISOString().slice(0, 10), label, date: d });
  }
  return days;
}
const HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

/** Quote acceptance = picking a slot (QUOTED → SCHEDULED on the API). */
function ScheduleSheet({ job, onDone }: { job: any; onDone: () => void }) {
  const schedule = useScheduleJob();
  const days = upcomingDays();
  const [dayKey, setDayKey] = useState<string>(days[0]!.key);
  const [time, setTime] = useState<string>('09:00');

  const confirm = () => {
    const scheduledFor = new Date(`${dayKey}T${time}:00`);
    if (scheduledFor.getTime() < Date.now()) {
      Alert.alert('Pick a later time', 'That time has already passed today.');
      return;
    }
    schedule.mutate(
      { id: job.id, scheduledFor: scheduledFor.toISOString() },
      { onSuccess: onDone },
    );
  };

  return (
    <View className="mt-md rounded-2xl bg-surface-subtle p-md">
      <Text className="text-sm font-semibold text-text-secondary">Pick a day</Text>
      <View className="mt-sm flex-row flex-wrap" style={{ gap: 8 }}>
        {days.map((d) => (
          <ChoiceChip key={d.key} label={d.label} active={d.key === dayKey} onPress={() => setDayKey(d.key)} />
        ))}
      </View>
      <Text className="mt-md text-sm font-semibold text-text-secondary">Pick a time</Text>
      <View className="mt-sm flex-row flex-wrap" style={{ gap: 8 }}>
        {HOURS.map((h) => (
          <ChoiceChip key={h} label={h} active={h === time} onPress={() => setTime(h)} />
        ))}
      </View>
      <Button
        label={`Accept quote — book for ${days.find((d) => d.key === dayKey)?.label ?? ''} ${time}`}
        className="mt-md"
        loading={schedule.isPending}
        onPress={confirm}
      />
      {schedule.isError ? (
        <Text className="mt-sm text-center text-sm text-error">
          {(schedule.error as any)?.response?.data?.message ?? 'Couldn’t schedule. Try again.'}
        </Text>
      ) : null}
    </View>
  );
}

function RateRow({ job }: { job: any }) {
  const rate = useRateJob();
  const [score, setScore] = useState(0);
  // Already rated in a past session → the API answers with a conflict; show it calmly.
  const errMsg = (rate.error as any)?.response?.data?.message;
  return (
    <View className="mt-sm flex-row items-center">
      <Text className="mr-sm text-sm text-text-secondary">Rate the work:</Text>
      {[1, 2, 3, 4, 5].map((s) => (
        <PressableScale
          key={s}
          hitSlop={4}
          disabled={rate.isPending || rate.isSuccess}
          onPress={() => {
            setScore(s);
            rate.mutate({ id: job.id, score: s });
          }}
        >
          <Feather
            name="star"
            size={20}
            color={s <= score && score > 0 ? color.warning : color.text.muted}
            style={{ marginRight: 4 }}
          />
        </PressableScale>
      ))}
      {rate.isSuccess ? <Text className="ml-sm text-sm text-success">Thanks!</Text> : null}
      {rate.isError ? <Text className="ml-sm flex-1 text-xs text-text-muted" numberOfLines={1}>{errMsg ?? 'Couldn’t rate'}</Text> : null}
    </View>
  );
}

function JobCard({ job, navigation }: { job: any; navigation: any }) {
  const cancel = useCancelJob();
  const [scheduling, setScheduling] = useState(false);
  const status = STATUS_LABEL[job.status] ?? { label: job.status, tone: 'neutral' as const };

  const confirmCancel = () =>
    Alert.alert('Cancel request', 'Withdraw this job request?', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel job', style: 'destructive', onPress: () => cancel.mutate(job.id) },
    ]);

  return (
    <Card className="mb-md">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-md">
          <Text className="text-base font-semibold" numberOfLines={2}>{job.description}</Text>
          <Text className="mt-xs text-xs text-text-muted">
            {new Date(job.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            {job.scheduledFor ? ` · booked ${new Date(job.scheduledFor).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
          </Text>
        </View>
        <Badge label={status.label} tone={status.tone} />
      </View>

      {job.status === 'QUOTED' && job.quoteAmount != null ? (
        <View className="mt-sm rounded-2xl bg-brand-50 px-md py-sm">
          <Text className="text-base font-bold text-brand-700">Quote: {money(job.quoteAmount)}</Text>
          <Text className="text-xs text-text-secondary">Cash on completion — accept by booking a time.</Text>
        </View>
      ) : null}

      {job.status === 'SCHEDULED' && job.quoteAmount != null ? (
        <Text className="mt-sm text-sm text-text-secondary">Agreed price: {money(job.quoteAmount)} · cash on completion</Text>
      ) : null}

      {scheduling && job.status === 'QUOTED' ? (
        <ScheduleSheet job={job} onDone={() => setScheduling(false)} />
      ) : null}

      <View className="mt-sm flex-row" style={{ gap: 8 }}>
        {job.status === 'QUOTED' && !scheduling ? (
          <Button label="Accept & book" className="flex-1" onPress={() => setScheduling(true)} />
        ) : null}
        {job.chatRoomId && !['COMPLETED', 'CANCELLED'].includes(job.status) ? (
          <Button
            label="Chat"
            variant="outline"
            className="flex-1"
            onPress={() => navigation.navigate('Chat', { roomId: job.chatRoomId, title: 'Job chat' })}
          />
        ) : null}
        {['REQUESTED', 'QUOTED'].includes(job.status) ? (
          <Button label="Cancel" variant="outline" className="flex-1" loading={cancel.isPending} onPress={confirmCancel} />
        ) : null}
      </View>

      {job.status === 'COMPLETED' ? <RateRow job={job} /> : null}
    </Card>
  );
}

export function ServiceJobsScreen({ navigation }: any) {
  const q = useServiceJobs<any[]>();
  const jobs = q.data ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Heading size="xl" className="ml-md">My service jobs</Heading>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={color.brand[500]} />}
      >
        {q.isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="mb-md h-28 w-full rounded-2xl" />)
        ) : jobs.length === 0 ? (
          <EmptyState
            icon="toolbox-outline"
            title="No jobs yet"
            body="Request a pro from Services and quotes land here."
          />
        ) : (
          jobs.map((j) => <JobCard key={j.id} job={j} navigation={navigation} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
