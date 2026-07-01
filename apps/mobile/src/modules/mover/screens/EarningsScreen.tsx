import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, PressableScale, Spinner, elevation } from '../../../components/ui';
import { useMoverKind, useEarningsSummary, useEarnings } from '../../../hooks';
import { money } from '../../../lib/money';

function StatCard({ label, total, count, sub }: { label: string; total: number; count?: number; sub?: string }) {
  return (
    <View className="flex-1 rounded-2xl bg-surface-base p-md" style={elevation.card}>
      <Text className="text-[11px] font-bold uppercase tracking-wider text-text-muted">{label}</Text>
      <Text className="mt-0.5 font-display text-xl font-extrabold text-text-primary" numberOfLines={1}>
        {money(total)}
      </Text>
      <Text className="text-xs text-text-muted">{sub ?? `${count ?? 0} ${count === 1 ? 'job' : 'jobs'}`}</Text>
    </View>
  );
}

function earnLabel(t?: string) {
  const s = (t ?? 'Trip').replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function dateLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function EarningsScreen({ navigation }: any) {
  const { kind } = useMoverKind();
  const summaryQ = useEarningsSummary<any>(kind);
  const historyQ = useEarnings<any>(kind);
  const s: any = summaryQ.data ?? {};
  const raw: any = historyQ.data;
  const history: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.earnings ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8} className="mr-sm">
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Heading size="xl">Earnings</Heading>
      </View>

      {summaryQ.isLoading ? (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {/* This-week hero */}
          <View className="rounded-3xl bg-surface-base p-lg" style={elevation.card}>
            <Text className="text-[11px] font-bold uppercase tracking-wider text-text-muted">This week</Text>
            <Text className="mt-0.5 font-display text-4xl font-extrabold text-text-primary">{money(s.thisWeek?.total ?? 0)}</Text>
            <View className="mt-1 flex-row items-center">
              <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
              <Text className="ml-1 text-xs font-bold text-success">100% yours · cash · 0% commission</Text>
            </View>
            <Text className="mt-0.5 text-xs text-text-muted">{s.thisWeek?.count ?? 0} jobs this week</Text>
          </View>

          {/* Stat grid */}
          <View className="mt-md flex-row" style={{ gap: 10 }}>
            <StatCard label="Today" total={s.today?.total ?? 0} count={s.today?.count ?? 0} />
            <StatCard label="This month" total={s.thisMonth?.total ?? 0} count={s.thisMonth?.count ?? 0} />
          </View>
          <View className="mt-md flex-row" style={{ gap: 10 }}>
            <StatCard label="All time" total={s.allTime?.total ?? 0} count={s.allTime?.count ?? 0} />
            <StatCard label="Pending payout" total={s.pendingPayout ?? 0} sub="cash in hand" />
          </View>

          {/* Model line */}
          <View className="mt-md flex-row items-center rounded-2xl bg-surface-base p-md" style={elevation.card}>
            <MaterialCommunityIcons name="calendar-check" size={16} color={color.brand[500]} />
            <Text className="ml-2 flex-1 text-xs text-text-secondary">
              You keep every cent — Swift only charges a flat weekly fee. No commission, ever.
            </Text>
          </View>

          {/* Recent earnings */}
          {history.length > 0 ? (
            <>
              <Text className="mb-xs mt-lg text-sm font-bold text-text-primary">Recent</Text>
              <View className="overflow-hidden rounded-2xl bg-surface-base" style={elevation.card}>
                {history.slice(0, 30).map((e: any, i: number) => (
                  <View
                    key={e.id ?? i}
                    className={i > 0 ? 'flex-row items-center border-t border-border-subtle px-md py-sm' : 'flex-row items-center px-md py-sm'}
                  >
                    <View className="h-8 w-8 items-center justify-center rounded-full bg-surface-subtle">
                      <MaterialCommunityIcons name="cash" size={15} color={color.success} />
                    </View>
                    <View className="ml-sm flex-1">
                      <Text className="text-sm font-semibold text-text-primary">{earnLabel(e.type)}</Text>
                      <Text className="text-xs text-text-muted">{dateLabel(e.createdAt)}</Text>
                    </View>
                    <Text className="font-display text-sm font-bold text-text-primary">{money(Number(e.amount ?? 0))}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
