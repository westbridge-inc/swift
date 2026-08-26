/** @jsxImportSource react */
import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { useReportRating, useVendorReviews } from '../../../hooks/customer';
import { ActionSheet, Card, EmptyState, ErrorState, Header, LoadingBlock, Screen, Stars, T } from '../../../kit';
import { toast } from '../../../kit/toast';

/** [B15] The curated report reasons (R7), in the reporter's words. */
const REPORT_REASONS = [
  { key: 'OFFENSIVE', label: 'It’s offensive' },
  { key: 'FALSE_CLAIM', label: 'It’s not true' },
  { key: 'PRIVATE_INFO', label: 'It shares private information' },
  { key: 'SPAM', label: 'It’s spam' },
  { key: 'OTHER', label: 'Something else' },
] as const;

// No dedicated kit frame — composed from the kit's card + gold-star language.
export function VendorReviewsScreen() {
  const route = useRoute<any>();
  const vendorId: string = route.params?.vendorId;
  const reviews = useVendorReviews<any>(vendorId);
  // [B15] Which review the report sheet is open for. The moderation queue has
  // existed the whole time; nothing in the app could fill it.
  const [reporting, setReporting] = useState<string | null>(null);
  const report = useReportRating();

  const fileReport = (reason: (typeof REPORT_REASONS)[number]['key']) => {
    if (!reporting) return;
    report.mutate(
      { ratingId: reporting, reason },
      {
        onSuccess: () => toast.success('Thanks — our team will look', 'Reports are reviewed by a human.'),
        onError: () => toast.error('Couldn’t send that report', 'Check your connection and try again.'),
      },
    );
    setReporting(null);
  };

  const rows: any[] = Array.isArray(reviews.data) ? reviews.data : (reviews.data?.reviews ?? []);

  return (
    <Screen>
      <Header title="Reviews" />
      {reviews.isLoading ? (
        <LoadingBlock />
      ) : reviews.isError ? (
        <ErrorState onRetry={() => reviews.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="star" title="No reviews yet" body="Ratings land here after customers order and rate." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r, i) => r.id ?? String(i)}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          renderItem={({ item: r }) => (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Stars value={Number(r.score ?? r.rating ?? 0)} size={16} />
                <T variant="caption" tone="faint">
                  {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}
                </T>
              </View>
              {r.comment ? (
                <T variant="body" style={{ marginTop: space.md }}>
                  {r.comment}
                </T>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm }}>
                <T variant="caption" tone="muted">
                  {r.customerName ?? r.author ?? 'Swift customer'}
                </T>
                {/* [B15] Quiet by design — a flag, not a button that competes
                    with the review. The label rides accessibility. */}
                {r.id ? (
                  <Pressable
                    onPress={() => setReporting(String(r.id))}
                    accessibilityRole="button"
                    accessibilityLabel="Report this review"
                    hitSlop={space.sm}
                    style={{ padding: space.xs }}
                  >
                    <Feather name="flag" size={14} color={color.text.muted} />
                  </Pressable>
                ) : null}
              </View>
              {r.response ? (
                <View
                  style={{
                    marginTop: space.md,
                    padding: space.md,
                    borderRadius: 12,
                    backgroundColor: color.brand[50],
                  }}
                >
                  <T variant="caption" weight="semibold" tone="deep">
                    Store reply
                  </T>
                  <T variant="label" tone="deep" style={{ marginTop: 2 }}>
                    {r.response}
                  </T>
                </View>
              ) : null}
            </Card>
          )}
        />
      )}

      {/* [B15] One sheet for the whole list; selecting IS filing. */}
      <ActionSheet
        open={!!reporting}
        onClose={() => setReporting(null)}
        title="Report this review"
        actions={REPORT_REASONS.map((reason) => ({
          label: reason.label,
          onPress: () => fileReport(reason.key),
        }))}
      />
    </Screen>
  );
}
