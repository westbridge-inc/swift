/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';
import { AdChip } from './AdChip';
import { useAdViewability } from './useAdViewability';
import { shouldPrimeHeroVideo } from './hero-video-gate';
import { trackAdEvent, openAdDestination } from '../../lib/ads';
import type { AdEventScope, AdServeItem } from '../../lib/adsCore';

// Tier 1 — the hero video card (spec §13.1). Poster first; autoplay MUTED when
// ≥50% on screen; pause when scrolled off (battery/data — the Caribbean device
// matrix applies); mute toggle; remaining-time chip; tap → destination + CLICK.
// Failure ladder (E8): video load fails → poster as a static banner → poster
// fails → collapse. expo-video is a native module: a stale binary without it
// must degrade to the poster banner, never crash at import
// [reference_swift_native_module_crash] — hence the guarded require.

let videoModule: typeof import('expo-video') | null = null;
try {
  videoModule = require('expo-video');
} catch {
  videoModule = null;
}

const HERO_H = 200;
const QUARTILES = [
  { at: 0.25, event: 'VIDEO_Q25' },
  { at: 0.5, event: 'VIDEO_Q50' },
  { at: 0.75, event: 'VIDEO_Q75' },
] as const;

export function AdHeroVideo({
  item,
  trackable,
  trackingScope,
}: {
  item: AdServeItem;
  trackable: boolean;
  trackingScope: AdEventScope | null;
}) {
  const track = trackable ? item.impressionToken : undefined;
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoPrimed, setVideoPrimed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [muted, setMuted] = useState(true);
  const [remaining, setRemaining] = useState<number | null>(null);
  const startedRef = useRef(false);
  const firedQuartiles = useRef(new Set<string>());
  const visibleRef = useRef(0);

  useEffect(() => {
    trackAdEvent(track, 'IMPRESSION', trackingScope);
  }, [track, trackingScope]);

  const videoEligible = item.kind === 'VIDEO' && !!videoModule && !videoFailed;
  const useVideo = videoEligible && videoPrimed;

  // One hook drives both the viewable event and the play/pause visibility gate.
  const playerRef = useRef<import('expo-video').VideoPlayer | null>(null);
  const videoPrimedRef = useRef(false);
  const syncPlayerForVisibility = useCallback((player: import('expo-video').VideoPlayer | null, fraction: number) => {
    if (!player) return;
    try {
      if (fraction >= 0.5 && !player.playing) {
        player.play();
        if (!startedRef.current) {
          startedRef.current = true;
          trackAdEvent(track, 'VIDEO_START', trackingScope);
        }
      } else if (fraction < 0.5 && player.playing) {
        player.pause();
      }
    } catch {
      setVideoFailed(true);
    }
  }, [track, trackingScope]);

  const handleVisibility = useCallback((fraction: number) => {
    visibleRef.current = fraction;
    if (!videoPrimedRef.current && shouldPrimeHeroVideo(fraction)) {
      videoPrimedRef.current = true;
      setVideoPrimed(true);
    }
    syncPlayerForVisibility(playerRef.current, fraction);
  }, [syncPlayerForVisibility]);

  const handleViewable = useCallback(() => {
    trackAdEvent(track, 'VIEWABLE_IMPRESSION', trackingScope);
  }, [track, trackingScope]);

  const { ref } = useAdViewability({
    enabled: !!track || videoEligible,
    keepMeasuring: videoEligible,
    onViewable: handleViewable,
    onVisibility: handleVisibility,
  });

  const onPress = useCallback(() => {
    trackAdEvent(track, 'CLICK', trackingScope);
    void openAdDestination(item.destination);
  }, [item.destination, track, trackingScope]);

  const handlePlayer = useCallback((player: import('expo-video').VideoPlayer | null) => {
    playerRef.current = player;
    syncPlayerForVisibility(player, visibleRef.current);
  }, [syncPlayerForVisibility]);

  const handleProgress = useCallback((position: number, duration: number) => {
    if (duration <= 0) return;
    setRemaining(Math.max(0, Math.ceil(duration - position)));
    const fraction = position / duration;
    for (const q of QUARTILES) {
      if (fraction >= q.at && !firedQuartiles.current.has(q.event)) {
        firedQuartiles.current.add(q.event);
        trackAdEvent(track, q.event, trackingScope);
      }
    }
    if (fraction >= 0.98 && !firedQuartiles.current.has('VIDEO_COMPLETE')) {
      firedQuartiles.current.add('VIDEO_COMPLETE');
      trackAdEvent(track, 'VIDEO_COMPLETE', trackingScope);
    }
  }, [track, trackingScope]);

  const handleVideoError = useCallback(() => setVideoFailed(true), []);

  if (posterFailed && (!videoEligible || videoFailed)) return null; // end of the ladder — collapse

  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Advertisement video: ${item.headline ?? item.advertiserName}`}
        onPress={onPress}
        style={styles.card}
      >
        {item.posterUrl || !useVideo ? (
          <Image
            source={{ uri: item.posterUrl ?? item.mediaUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            onError={() => setPosterFailed(true)}
          />
        ) : null}
        {useVideo && videoModule ? (
          <HeroPlayer
            module={videoModule}
            uri={item.mediaUrl}
            muted={muted}
            onPlayer={handlePlayer}
            onProgress={handleProgress}
            onError={handleVideoError}
          />
        ) : null}
        <AdChip advertiserName={item.advertiserName} />
        {useVideo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute advertisement' : 'Mute advertisement'}
            onPress={() => setMuted((m) => !m)}
            style={styles.mute}
            hitSlop={10}
          >
            <Feather name={muted ? 'volume-x' : 'volume-2'} size={14} color={color.white} />
          </Pressable>
        ) : null}
        {useVideo && remaining !== null ? (
          <View style={styles.remaining}>
            <T variant="caption" style={styles.remainingText}>
              {remaining}s
            </T>
          </View>
        ) : null}
        {item.headline ? (
          <View style={styles.copy}>
            <T variant="heading" style={styles.headline} numberOfLines={2}>
              {item.headline}
            </T>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

/** Isolated so expo-video hooks only run when the module exists. */
function HeroPlayer({
  module: video,
  uri,
  muted,
  onPlayer,
  onProgress,
  onError,
}: {
  module: NonNullable<typeof videoModule>;
  uri: string;
  muted: boolean;
  onPlayer: (p: import('expo-video').VideoPlayer | null) => void;
  onProgress: (position: number, duration: number) => void;
  onError: () => void;
}) {
  const player = video.useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = true;
    p.timeUpdateEventInterval = 0.5;
  });

  useEffect(() => {
    onPlayer(player);
    return () => onPlayer(null);
  }, [player, onPlayer]);

  useEffect(() => {
    try {
      player.muted = muted;
    } catch {
      onError();
    }
  }, [muted, player, onError]);

  useEffect(() => {
    const timeSub = player.addListener('timeUpdate', (e) => onProgress(e.currentTime, player.duration));
    const statusSub = player.addListener('statusChange', (e) => {
      if (e.status === 'error') onError();
    });
    return () => {
      timeSub.remove();
      statusSub.remove();
    };
  }, [player, onProgress, onError]);

  const { VideoView } = video;
  return (
    <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
  );
}

const styles = StyleSheet.create({
  card: {
    height: HERO_H,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.surface.subtle,
    justifyContent: 'flex-end',
  },
  mute: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.mediaChip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remaining: {
    position: 'absolute',
    bottom: space.sm,
    right: space.sm,
    backgroundColor: color.mediaChip,
    borderRadius: radius.full,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  remainingText: { color: color.white },
  copy: {
    padding: space.lg,
    paddingBottom: space.md,
  },
  headline: {
    color: color.white,
    textShadowColor: color.mediaInkShadow,
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
});
