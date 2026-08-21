import { create } from 'zustand';
import { Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text } from './text';
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
const TOAST_MS = 2600;

function dismiss(id: number) {
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function push(tone: Tone, title: string, description?: string) {
  const id = ++seq;
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-1), { id, tone, title, description }] }));
  setTimeout(() => dismiss(id), TOAST_MS);
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
