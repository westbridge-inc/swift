/** @jsxImportSource react */
import React, { useState } from 'react';
import { RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { useServiceJobs, useScheduleJob, useCancelJob, useRateJob, useQuoteJob, useConfirmJob, useDeclineSlot, useCompleteJob } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';
import { Card, Chip, EmptyState, Header, IconChip, LoadingBlock, PillButton, PopupCard, Screen, Stars, T, TonePill } from '../../../kit';

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
  const [pastErr, setPastErr] = useState(false);

  const confirm = () => {
    const scheduledFor = new Date(`${dayKey}T${time}:00`);
    if (scheduledFor.getTime() < Date.now()) {
      setPastErr(true);
      return;
    }
    setPastErr(false);
    schedule.mutate({ id: job.id, scheduledFor: scheduledFor.toISOString() }, { onSuccess: onDone });
  };

  return (
    <View style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.lg }}>
      <T variant="label" weight="semibold" tone="muted">
        Pick a day
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
        {days.map((d) => (
          <Chip key={d.key} label={d.label} selected={d.key === dayKey} onPress={() => setDayKey(d.key)} style={{ height: 36, paddingHorizontal: space.md }} />
        ))}
      </View>
      <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg }}>
        Pick a time
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
        {HOURS.map((h) => (
          <Chip key={h} label={h} selected={h === time} onPress={() => setTime(h)} style={{ height: 36, paddingHorizontal: space.md }} />
        ))}
      </View>
      <PillButton
        label={`Accept quote — ${days.find((d) => d.key === dayKey)?.label ?? ''} ${time}`}
        size="md"
        style={{ marginTop: space.lg }}
        loading={schedule.isPending}
        onPress={confirm}
      />
      {pastErr ? (
        <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
          That time has already passed today — pick a later one.
        </T>
      ) : null}
      {schedule.isError ? (
        <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
          {(schedule.error as any)?.response?.data?.message ?? 'Couldn’t schedule. Try again.'}
        </T>
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
      <T variant="label" tone="muted">
        Rate the work:
      </T>
      <Stars
        value={score}
        size={22}
        gap={4}
        onRate={
          rate.isPending || rate.isSuccess
            ? undefined
            : (n) => {
                setScore(n);
                rate.mutate({ id: job.id, score: n });
              }
        }
      />
      {rate.isSuccess ? (
        <T variant="label" tone="success">
          Thanks!
        </T>
      ) : null}
      {rate.isError ? (
        <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
          {errMsg ?? 'Couldn’t rate'}
        </T>
      ) : null}
    </View>
  );
}

/** Provider-side controls: quote a REQUESTED job; confirm/decline a slot (§4.3). */
function ProviderActions({ job }: { job: any }) {
  const quote = useQuoteJob();
  const confirm = useConfirmJob();
  const decline = useDeclineSlot();
  const complete = useCompleteJob();
  const [amount, setAmount] = useState('');

  if (job.status === 'REQUESTED') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
        <View
          style={{
            flex: 1,
            height: 48,
            borderRadius: 9999,
            borderWidth: 1,
            borderColor: color.border.subtle,
            backgroundColor: color.surface.base,
            paddingHorizontal: space.lg,
            justifyContent: 'center',
          }}
        >
          <TextInput
            value={amount}
            onChangeText={setAmount}
            placeholder="Quote (GYD)"
            placeholderTextColor={color.text.muted}
            keyboardType="number-pad"
            style={{ fontFamily: 'Hanken', fontSize: 15, color: color.text.primary, paddingVertical: 0 }}
          />
        </View>
        <PillButton
          label="Send quote"
          size="md"
          loading={quote.isPending}
          disabled={!(Number(amount) > 0)}
          onPress={() => quote.mutate({ id: job.id, amount: Number(amount) })}
        />
      </View>
    );
  }
  if (job.status === 'SCHEDULED' && !job.providerConfirmedAt) {
    return (
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        <PillButton label="Confirm time" size="md" style={{ flex: 1 }} loading={confirm.isPending} onPress={() => confirm.mutate(job.id)} />
        <PillButton label="Can’t make it" variant="outline" size="md" style={{ flex: 1 }} loading={decline.isPending} onPress={() => decline.mutate(job.id)} />
      </View>
    );
  }
  if (job.status === 'SCHEDULED' && job.providerConfirmedAt) {
    return (
      <View style={{ marginTop: space.md }}>
        <PillButton label="Mark job complete" size="md" loading={complete.isPending} onPress={() => complete.mutate(job.id)} />
      </View>
    );
  }
  return null;
}

function JobCard({ job, navigation }: { job: any; navigation: any }) {
  const myId = useAuthStore((s) => s.user?.id);
  const isCustomer = job.customerId === myId;
  const cancel = useCancelJob();
  const [scheduling, setScheduling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = STATUS_LABEL[job.status] ?? { label: job.status, tone: 'neutral' as const };

  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <T variant="body" weight="semibold" numberOfLines={2}>
            {job.description}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
            {new Date(job.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            {job.scheduledFor
              ? ` · booked ${new Date(job.scheduledFor).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
              : ''}
          </T>
        </View>
        <TonePill label={status.label} tone={status.tone} />
      </View>

      {job.status === 'QUOTED' && job.quoteAmount != null ? (
        <View style={{ marginTop: space.md, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: color.brand[50] }}>
          <T variant="body" weight="bold" tone="deep">
            Quote: {money(job.quoteAmount)}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            Cash on completion — accept by booking a time.
          </T>
        </View>
      ) : null}

      {job.status === 'SCHEDULED' && job.quoteAmount != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
          <T variant="label" tone="muted" style={{ flex: 1 }}>
            Agreed price: {money(job.quoteAmount)} · cash on completion
          </T>
          <TonePill
            label={job.providerConfirmedAt ? 'Time confirmed' : 'Awaiting confirmation'}
            tone={job.providerConfirmedAt ? 'success' : 'neutral'}
          />
        </View>
      ) : null}

      {isCustomer && scheduling && job.status === 'QUOTED' ? <ScheduleSheet job={job} onDone={() => setScheduling(false)} /> : null}

      {!isCustomer ? <ProviderActions job={job} /> : null}

      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        {isCustomer && job.status === 'QUOTED' && !scheduling ? (
          <PillButton label="Accept & book" size="md" style={{ flex: 1 }} onPress={() => setScheduling(true)} />
        ) : null}
        {job.chatRoomId && !['COMPLETED', 'CANCELLED'].includes(job.status) ? (
          <PillButton
            label="Chat"
            variant="soft"
            size="md"
            style={{ flex: 1 }}
            onPress={() => navigation.navigate('Chat', { roomId: job.chatRoomId, title: 'Job chat' })}
          />
        ) : null}
        {isCustomer && ['REQUESTED', 'QUOTED'].includes(job.status) ? (
          <PillButton label="Cancel" variant="outline" size="md" style={{ flex: 1 }} loading={cancel.isPending} onPress={() => setConfirmCancel(true)} />
        ) : null}
      </View>

      {isCustomer && job.status === 'COMPLETED' ? <RateRow job={job} /> : null}

      {/* Kit confirm popup */}
      <PopupCard visible={confirmCancel} onClose={() => setConfirmCancel(false)}>
        <IconChip icon="x-circle" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Cancel request?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          This withdraws the job request.
        </T>
        <PillButton
          label="Cancel job"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setConfirmCancel(false);
            cancel.mutate(job.id);
          }}
        />
        <PillButton label="Keep it" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmCancel(false)} />
      </PopupCard>
    </Card>
  );
}

export function ServiceJobsScreen({ navigation }: any) {
  const q = useServiceJobs<any[]>();
  const jobs = q.data ?? [];

  return (
    <Screen>
      <Header title="My Jobs" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space.sm, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={color.brand[500]} />}
      >
        {q.isLoading ? (
          <LoadingBlock />
        ) : jobs.length === 0 ? (
          <EmptyState icon="tool" title="No jobs yet" body="Request a pro from Services and quotes land here." />
        ) : (
          jobs.map((j) => <JobCard key={j.id} job={j} navigation={navigation} />)
        )}
      </ScrollView>
    </Screen>
  );
}
