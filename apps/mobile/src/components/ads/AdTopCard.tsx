/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';
import { AdChip } from './AdChip';
import { useAdViewability } from './useAdViewability';
import { trackAdEvent, openAdDestination } from '../../lib/ads';
import type { AdServeItem } from '../../lib/adsCore';

// Tier 2 — the top card (spec §13.2). One static image + headline + CTA.
// Fixed height so hydration never shifts the home layout; IMPRESSION on
// mount, VIEWABLE per §12.1, CLICK + destination on tap. Collapse = the
// parent renders nothing when there is no item; failures collapse here.

const CARD_H = 140;

export function AdTopCard({ item, trackable }: { item: AdServeItem; trackable: boolean }) {
  const [failed, setFailed] = React.useState(false);
  const track = trackable ? item.impressionToken : undefined;

  useEffect(() => {
    trackAdEvent(track, 'IMPRESSION');
  }, [track]);

  const { ref } = useAdViewability({
    enabled: !!track,
    onViewable: () => trackAdEvent(track, 'VIEWABLE_IMPRESSION'),
  });

  if (failed) return null; // §13 fail silent — a broken image never leaves a hole

  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Advertisement: ${item.headline ?? item.advertiserName}`}
        onPress={() => {
          trackAdEvent(track, 'CLICK');
          void openAdDestination(item.destination);
        }}
        style={styles.card}
      >
        <Image
          source={{ uri: item.mediaUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          onError={() => setFailed(true)}
        />
        <View style={styles.scrim} />
        <AdChip advertiserName={item.advertiserName} />
        <View style={styles.copy}>
          {item.headline ? (
            <T variant="heading" style={styles.headline} numberOfLines={2}>
              {item.headline}
            </T>
          ) : null}
          {item.ctaLabel ? (
            <View style={styles.cta}>
              <T variant="label" style={styles.ctaText}>
                {item.ctaLabel}
              </T>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_H,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.surface.subtle,
    justifyContent: 'flex-end',
  },
  scrim: {
    ...(StyleSheet.absoluteFill as object),
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  copy: {
    padding: space.lg,
    gap: space.sm,
    alignItems: 'flex-start',
  },
  headline: { color: '#FFFFFF' },
  cta: {
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
    minHeight: 32,
    justifyContent: 'center',
  },
  ctaText: { color: color.text.primary },
});
