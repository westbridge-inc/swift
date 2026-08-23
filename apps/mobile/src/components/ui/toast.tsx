import { create } from 'zustand';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text } from './text';
import { toastDurationMs } from './toast-duration';
import { elevation } from './elevation';

/**
 * App-wide toast — quiet confirmation for actions that otherwise finish
 * silently (added to cart, saved, sent). Imperative API so any handler can
 * call it: `toast.success('Added to cart', item.name)`. `ToastHost` renders
 * ONCE at the app root; tone shows in the icon only (white card, no colored
 * floods). Tap dismisses; auto-dismiss after 2.6s; max two stacked.
 */
type Tone = 'success' | 'error' | 'info';
type ToastItem = { id: number; tone: Tone; title: string; description?: string };

const useToastStore = create<{ toasts: ToastItem[] }>(() => ({ toasts: [] }));
let seq = 0;

/**
 * [F-027-06] Screen-reader awareness for the auto-dismiss timer. The duration
 * policy itself lives in ./toast-duration so it can be tested without React
 * Native, the same split as kit/text-scale.
 */
let screenReaderOn = false;
// [F-028-18] The initial detection is async and the default is `false`, so a
// toast fired at startup could take the SIGHTED timer while a reader was
// already on. Keep the promise: the first timer decisions await it instead
// of racing it. After it settles, the listener keeps the flag current.
const srDetection: Promise<void> = AccessibilityInfo.isScreenReaderEnabled()
  .then((on) => { screenReaderOn = on; })
  .catch(() => undefined);
AccessibilityInfo.addEventListener('screenReaderChanged', (on) => { screenReaderOn = on; });

// [F-028-18] How many announceable toasts are still LIVE ahead of a new one.
// A polite announcement queues behind everything speaking before it; sizing a
// window by its own speech alone let a short "Saved" be removed while still
// waiting its turn in the queue.
let liveAnnouncements = 0;

function dismiss(id: number) {
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function push(tone: Tone, title: string, description?: string) {
  const id = ++seq;
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-1), { id, tone, title, description }] }));
  const queuedAhead = liveAnnouncements;
  liveAnnouncements += 1;
  // The timer DECISION waits for the initial reader detection (already
  // resolved on every call after startup — this costs one microtask), so the
  // first toast of a session cannot take the sighted window under a reader.
  void srDetection.then(() => {
    const ms = toastDurationMs(tone, title, description, screenReaderOn, queuedAhead);
    if (ms != null) {
      setTimeout(() => { liveAnnouncements = Math.max(0, liveAnnouncements - 1); dismiss(id); }, ms);
    } else {
      // Persistent (reader + error): it leaves the queue when DISMISSED.
      liveAnnouncements = Math.max(0, liveAnnouncements - 1);
    }
  });
}

export const toast = {
  success: (title: string, description?: string) => push('success', title, description),
  error: (title: string, description?: string) => push('error', title, description),
  show: (title: string, description?: string) => push('info', title, description),
};

const ICON: Record<Tone, { name: keyof typeof MaterialCommunityIcons.glyphMap; tint: string }> = {
  success: { name: 'check-circle', tint: color.success },
  error: { name: 'alert-circle', tint: color.error },
  info: { name: 'information', tint: color.brand[500] },
};

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{ pointerEvents: 'box-none', position: 'absolute', top: insets.top + 8, left: 16, right: 16, zIndex: 100 }}
    >
      {toasts.map((t) => (
        <Animated.View key={t.id} entering={FadeInDown.duration(180)} exiting={FadeOutUp.duration(140)} style={{ marginBottom: 8 }}>
          {/* [F-243] A toast is how most of the app reports failure, so it has
              to reach a screen-reader user too: announce it as an alert (an
              error assertively, the rest politely — the OfflineBanner pattern)
              and label the tap so "dismiss" is discoverable rather than a
              mystery press on unlabelled text. */}
          <Pressable
            onPress={() => dismiss(t.id)}
            accessible
            accessibilityRole="alert"
            accessibilityLiveRegion={t.tone === 'error' ? 'assertive' : 'polite'}
            accessibilityLabel={t.description ? `${t.title}. ${t.description}` : t.title}
            accessibilityHint="Double tap to dismiss"
          >
            <View
              style={[
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: color.surface.base,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: color.border.subtle,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                },
                elevation.floating,
              ]}
            >
              <MaterialCommunityIcons name={ICON[t.tone].name} size={20} color={ICON[t.tone].tint} />
              <View style={{ flex: 1, marginLeft: 10, flexShrink: 1 }}>
                {/* The description carries the REASON a thing failed. Clipping
                    it to one line threw that away — worst at a large font
                    scale. Two lines, and shrink rather than a fixed box. */}
                <Text className="text-sm font-bold text-text-primary" numberOfLines={2}>{t.title}</Text>
                {t.description ? (
                  <Text className="text-xs text-text-secondary" numberOfLines={3}>{t.description}</Text>
                ) : null}
              </View>
            </View>
          </Pressable>
        </Animated.View>
      ))}
    </View>
  );
}
