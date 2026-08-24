/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, View, StyleSheet, type ViewToken } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';
import { AdChip } from './AdChip';
import { useAdViewability } from './useAdViewability';
import { trackAdEvent, openAdDestination } from '../../lib/ads';
import type { AdEventScope, AdServeItem } from '../../lib/adsCore';
import { ContentSafetyActions } from '../moderation/ContentSafetyActions';

// Tier 3 — the rotating ad bar (spec §13.3). Horizontal pager: auto-advances
// every rotationSeconds and loops; PAUSES while the user is touching/swiping
// and resumes 5 s after release; swipes work both directions; page dots; each
// tile fires its own VIEWABLE_IMPRESSION only while it is the CURRENT slide
// (§12.1 — the 1 s dwell rides the shared viewability hook, gated on index).
// One item → static, no dots, no timer.

const BAR_H = 92;
const RESUME_AFTER_MS = 5000;

export function AdBar({
  items,
  rotationSeconds,
  trackable,
  trackingScope,
  width,
}: {
  items: AdServeItem[];
  rotationSeconds: number | null;
  trackable: boolean;
  trackingScope: AdEventScope | null;
  width: number;
}) {
  const listRef = useRef<FlatList<AdServeItem>>(null);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const pausedUntil = useRef(0);
  const firedViewable = useRef(new Set<string>());
  const firedImpression = useRef(new Set<string>());

  // IMPRESSION once per tile per serve (rendered into the pager).
  useEffect(() => {
    if (!trackable) return;
    for (const it of items) {
      if (it.impressionToken && !firedImpression.current.has(it.impressionToken)) {
        firedImpression.current.add(it.impressionToken);
        trackAdEvent(it.impressionToken, 'IMPRESSION', trackingScope);
      }
    }
  }, [items, trackable, trackingScope]);

  // Container visibility: the CURRENT slide's viewable fires only while the bar
  // itself is ≥50% on screen for the 1 s dwell.
  const { ref: barRef, reset } = useAdViewability({
    enabled: trackable && items.length > 0,
    keepMeasuring: true,
    onViewable: () => {
      const current = items[indexRef.current];
      const token = current?.impressionToken;
      if (token && !firedViewable.current.has(token)) {
        firedViewable.current.add(token);
        trackAdEvent(token, 'VIEWABLE_IMPRESSION', trackingScope);
      }
    },
  });

  // Slide change → re-arm the dwell for the new current tile.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (first && typeof first.index === 'number') {
      indexRef.current = first.index;
      setIndex(first.index);
      reset();
    }
  });

  // Auto-advance timer — checks the pause window each tick.
  useEffect(() => {
    if (items.length <= 1 || !rotationSeconds) return;
    const timer = setInterval(() => {
      if (Date.now() < pausedUntil.current) return;
      const next = (indexRef.current + 1) % items.length;
      listRef.current?.scrollToIndex({ index: next, animated: true });
    }, rotationSeconds * 1000);
    return () => clearInterval(timer);
  }, [items.length, rotationSeconds]);

  const pause = useCallback(() => {
    pausedUntil.current = Number.MAX_SAFE_INTEGER; // touching — no auto-advance
  }, []);
  const scheduleResume = useCallback(() => {
    pausedUntil.current = Date.now() + RESUME_AFTER_MS; // §13.3 resume 5 s after release
  }, []);

  if (items.length === 0) return null;

  const renderTile = ({ item }: { item: AdServeItem }) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Advertisement: ${item.headline ?? item.advertiserName}`}
      onPress={() => {
        trackAdEvent(trackable ? item.impressionToken : undefined, 'CLICK', trackingScope);
        void openAdDestination(item.destination);
      }}
      style={[styles.tile, { width }]}
    >
      <Image source={{ uri: item.mediaUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      <View style={styles.scrim} />
      <AdChip advertiserName={item.advertiserName} />
      {item.headline ? (
        <View style={styles.copy}>
          <T variant="label" style={styles.headline} numberOfLines={1}>
            {item.headline}
          </T>
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <View ref={barRef} collapsable={false}>
      {items.length === 1 ? (
        renderTile({ item: items[0]! })
      ) : (
        <>
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => it.creativeId}
            renderItem={renderTile}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onTouchStart={pause}
            onTouchEnd={scheduleResume}
            onTouchCancel={scheduleResume}
            onScrollToIndexFailed={() => {}}
            onViewableItemsChanged={onViewableItemsChanged.current}
            viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          />
          <View style={styles.dots} accessibilityLabel={`Ad ${index + 1} of ${items.length}`}>
            {items.map((it, i) => (
              <View key={it.creativeId} style={[styles.dot, i === index && styles.dotActive]} />
            ))}
          </View>
        </>
      )}
      {items[index] ? (
        <ContentSafetyActions
          targetType="AD_CREATIVE"
          targetId={items[index]!.creativeId}
          contentLabel="advertisement"
          style={{ marginTop: space.sm }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    height: BAR_H,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.surface.subtle,
    justifyContent: 'flex-end',
  },
  scrim: {
    ...(StyleSheet.absoluteFill as object),
    backgroundColor: color.mediaScrim,
  },
  copy: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  headline: { color: color.white },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.border.subtle,
  },
  dotActive: {
    backgroundColor: color.brand[500],
    width: 16,
  },
});
