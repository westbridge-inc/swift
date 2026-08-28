/** @jsxImportSource react */
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * PHOTODROP — the vendor-side invitation to add a photograph.
 *
 * The customer-facing counterpart is `PhotoPlaceholder`, and the two must not
 * be confused, because they answer opposite questions:
 *
 *   PhotoPlaceholder  "there is no photo" — shown to someone who cannot fix it.
 *                     Designed, honest, and deliberately NOT a grey box.
 *   PhotoDrop         "add a photo" — shown to the one person who can. A
 *                     control, not a state.
 *
 * That is why this is dashed and pressable while the placeholder is filled and
 * inert: a dashed outline reads as an empty slot waiting to be filled, which is
 * exactly the incentive the photo policy wants on a vendor's own dashboard. An
 * unphotographed item should look plainly unfinished to the merchant who owns
 * it — the placeholder makes it honest to the customer, this makes it obviously
 * actionable to the vendor.
 *
 * It never invents a preview and never claims an upload succeeded: `uploading`
 * is the caller's fact, and `error` is shown as a retry invitation rather than
 * replacing the control with a dead end.
 */
export function PhotoDrop({
  onPress,
  label = 'Add a photo',
  hint,
  uploading = false,
  error,
  disabled = false,
  style,
}: {
  onPress: () => void;
  /** The action, in the vendor's words. */
  label?: string;
  /** What a good photo looks like here — guidance, never a requirement list. */
  hint?: string;
  /** Caller-owned: true only while a real upload is in flight. */
  uploading?: boolean;
  /** A failed upload. Shown WITH the control, so retry is one tap. */
  error?: string | null;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const blocked = disabled || uploading;
  const ink = error ? color.error : blocked ? color.text.muted : color.brand[500];
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked, busy: uploading }}
      // The hint and the error belong in the accessible name: someone who
      // cannot see the dashed box still needs to know what is wanted and what
      // went wrong.
      accessibilityLabel={[label, hint, error].filter(Boolean).join('. ')}
      style={style}
    >
      {({ pressed }) => (
        <View
          style={{
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: error ? color.error : blocked ? color.border.strong : color.brand[200],
            borderRadius: radius.lg,
            backgroundColor: error ? color.soft.danger : color.brand[50],
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.xs,
            paddingVertical: space['2xl'],
            paddingHorizontal: space.lg,
            opacity: pressed && !blocked ? 0.85 : 1,
          }}
        >
          <Feather name={error ? 'alert-circle' : uploading ? 'upload-cloud' : 'camera'} size={22} color={ink} />
          <T variant="label" weight="semibold" center style={{ color: ink }}>
            {uploading ? 'Uploading…' : error ? 'Upload failed — tap to retry' : label}
          </T>
          {/* The hint stays visible while uploading: it is guidance about the
              photo, not about the upload, and hiding it makes the box jump. */}
          {hint && !error ? (
            <T variant="caption" tone="muted" center>
              {hint}
            </T>
          ) : null}
          {error ? (
            <T variant="caption" center style={{ color: color.error }}>
              {error}
            </T>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
