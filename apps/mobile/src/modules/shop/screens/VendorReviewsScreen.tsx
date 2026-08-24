/** @jsxImportSource react */
import React from 'react';
import { FlatList, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useVendorReviews } from '../../../hooks/customer';
import { Card, EmptyState, ErrorState, Header, LoadingBlock, Screen, Stars, T } from '../../../kit';
import { ContentSafetyActions } from '../../../components/moderation/ContentSafetyActions';

// No dedicated kit frame — composed from the kit's card + gold-star language.
export function VendorReviewsScreen() {
  const route = useRoute<any>();
  const vendorId: string = route.params?.vendorId;
  const reviews = useVendorReviews<any>(vendorId);

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
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {r.customerName ?? r.author ?? 'Swift customer'}
              </T>
              {r.id ? (
                <ContentSafetyActions
                  targetType="RATING"
                  targetId={r.id}
                  contentLabel="review"
                  onBlocked={() => void reviews.refetch()}
                  style={{ marginTop: space.sm }}
                />
              ) : null}
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
                  <ContentSafetyActions
                    targetType="RATING_RESPONSE"
                    targetId={r.id}
                    contentLabel="store reply"
                    onBlocked={() => void reviews.refetch()}
                    style={{ marginTop: space.sm }}
                  />
                </View>
              ) : null}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
