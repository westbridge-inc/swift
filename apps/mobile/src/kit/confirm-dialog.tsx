import { View } from 'react-native';
import { color, space } from '@swift/ui';
import { PopupCard, PopupTitle } from './card';
import { PillButton } from './button';
import { T } from './text';

/**
 * Centered confirm dialog for decisions that deserve a pause (log out,
 * cancel an order). Two buttons only; `destructive` paints the confirm in
 * the error tone so it never reads as the brand action.
 *
 * [DRIFT-09] Kit port of components/ui/confirm-dialog — same API, now
 * COMPOSED from the kit's own PopupCard/PopupTitle/PillButton instead of a
 * second modal implementation, so every confirm in the app shares one shell
 * (and one accessibility contract).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <PopupCard visible={open} onClose={onClose}>
      <PopupTitle variant="title" center>{title}</PopupTitle>
      {body ? (
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {body}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md, alignSelf: 'stretch', marginTop: space['2xl'] }}>
        <PillButton label={cancelLabel} variant="soft" style={{ flex: 1 }} disabled={loading} onPress={onClose} />
        <PillButton
          label={confirmLabel}
          style={{ flex: 1, ...(destructive ? { backgroundColor: color.error } : null) }}
          loading={loading}
          onPress={onConfirm}
        />
      </View>
    </PopupCard>
  );
}
