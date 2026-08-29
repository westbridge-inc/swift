/** @jsxImportSource react */
import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useCategorySuggestions, useResolveCategorySuggestion } from '../../../hooks/vendorops';
import { Card, EmptyState, ErrorState, LoadingBlock, PhotoPlaceholder, Screen, T } from '../../../kit';
import { toast } from '../../../kit/toast';
import { haptic } from '../../../lib/haptics';

/**
 * REVIEW YOUR CATEGORIES — the last step before a listing reaches the Market.
 *
 * The backfill reads a store's catalogue, proposes a category per item from the
 * alias dictionary, and notifies the owner: "review your categories — takes
 * about two minutes". Accepting a suggestion is what writes the
 * `ItemDiscoveryCategory` row the Market feed filters on. Nothing else does.
 *
 * There was nowhere to do it. The API could list suggestions per item and
 * accept one, and NOTHING in the app called either — so the push arrived, the
 * vendor tapped it, and landed on whatever screen they were last on. Measured
 * on the live database: 50 suggestions PENDING, 0 tags, 12 vendors notified.
 * The Market could not fill, however correct its feed.
 *
 * Grouped by item because that is how a shopkeeper thinks — "what is this
 * thing", not "dispose of forty unrelated proposals". Ordered by the matcher's
 * confidence so the obvious calls go first.
 *
 * BOTH ANSWERS ARE FINAL, and the copy says so. Machines never re-touch
 * resolved ground: a dismissal is remembered exactly as an acceptance is, which
 * is what stops the classifier proposing the same thing again next week.
 */
export function VendorCategoryReviewScreen() {
  const navigation = useNavigation<any>();
  const q = useCategorySuggestions();
  const resolve = useResolveCategorySuggestion();

  const groups: Array<{
    itemId: string;
    itemName: string;
    imageUrl: string | null;
    suggestions: Array<{ id: string; slug: string; name: string; emoji: string; confidence: number; stage: string }>;
  }> = Array.isArray(q.data) ? q.data : [];

  const act = (id: string, action: 'accept' | 'dismiss', categoryName: string) => {
    haptic.select();
    resolve.mutate(
      { id, action },
      {
        onSuccess: () =>
          toast.success(action === 'accept' ? `Added to ${categoryName}` : 'Suggestion dismissed'),
        onError: (e: any) =>
          toast.error(e?.response?.data?.error?.message ?? 'Couldn’t save that — try again.'),
      },
    );
  };

  const total = groups.reduce((n, g) => n + g.suggestions.length, 0);

  return (
    <Screen>
      <View style={{ paddingHorizontal: space['2xl'], paddingTop: space.lg, paddingBottom: space.md }}>
        <Pressable onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </Pressable>
        <T variant="title" style={{ marginTop: space.md }}>
          Review your categories
        </T>
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          {/* The count is the honest one — never "a few". */}
          {total > 0
            ? `${total} suggestion${total === 1 ? '' : 's'} across ${groups.length} item${groups.length === 1 ? '' : 's'}. Customers browse the Market by category, so a listing with none is harder to find.`
            : 'Customers browse the Market by category.'}
        </T>
      </View>

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          picto="shops"
          title="Nothing to review"
          body="Every listing that could be categorised has been. New suggestions appear here when you add items."
        />
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(g) => g.itemId}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'], gap: space.lg }}
          showsVerticalScrollIndicator={false}
          renderItem={({ item: group }) => (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <View style={{ width: 44, height: 44, borderRadius: radius.md, overflow: 'hidden' }}>
                  <PhotoPlaceholder label={group.itemName} glyph="shops" style={{ width: '100%', height: '100%' }} />
                </View>
                <T variant="body" weight="semibold" numberOfLines={2} style={{ flex: 1 }}>
                  {group.itemName}
                </T>
              </View>

              {group.suggestions.map((s) => (
                <View
                  key={s.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    marginTop: space.md,
                    paddingTop: space.md,
                    borderTopWidth: 1,
                    borderTopColor: color.border.subtle,
                  }}
                >
                  <T variant="body" style={{ flex: 1 }}>
                    {s.emoji} {s.name}
                  </T>

                  {/* Dismiss is quiet and accept is the brand action: the store
                      is being asked to confirm something, not warned about it. */}
                  <Pressable
                    onPress={() => act(s.id, 'dismiss', s.name)}
                    disabled={resolve.isPending}
                    accessibilityRole="button"
                    accessibilityLabel={`Not ${s.name} — dismiss this suggestion for ${group.itemName}`}
                    hitSlop={6}
                  >
                    {({ pressed }) => (
                      <View
                        style={{
                          paddingHorizontal: space.lg,
                          height: 36,
                          borderRadius: radius.full,
                          borderWidth: 1,
                          borderColor: color.border.strong,
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: pressed || resolve.isPending ? 0.6 : 1,
                        }}
                      >
                        <T variant="label" tone="muted">Not this</T>
                      </View>
                    )}
                  </Pressable>

                  <Pressable
                    onPress={() => act(s.id, 'accept', s.name)}
                    disabled={resolve.isPending}
                    accessibilityRole="button"
                    accessibilityLabel={`Yes, ${group.itemName} is ${s.name}`}
                    hitSlop={6}
                  >
                    {({ pressed }) => (
                      <View
                        style={{
                          paddingHorizontal: space.lg,
                          height: 36,
                          borderRadius: radius.full,
                          backgroundColor: color.brand[500],
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: pressed || resolve.isPending ? 0.7 : 1,
                        }}
                      >
                        <T variant="label" weight="semibold" tone="onBrand">Yes</T>
                      </View>
                    )}
                  </Pressable>
                </View>
              ))}
            </Card>
          )}
          ListFooterComponent={
            <T variant="caption" tone="faint" style={{ paddingTop: space.lg }}>
              Either answer is final — we won’t ask about the same listing again.
            </T>
          }
        />
      )}
    </Screen>
  );
}
