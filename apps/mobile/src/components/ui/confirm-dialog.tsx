import { Modal, View } from 'react-native';
import { color } from '@swift/ui';
import { Text, Heading } from './text';
import { Button } from './button';
import { elevation } from './elevation';

/**
 * Centered confirm dialog for decisions that deserve a pause (log out,
 * cancel an order). Two buttons only; `destructive` paints the confirm in
 * the error tone so it never reads as the brand action.
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
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.scrim, paddingHorizontal: 24 }}>
        <View
          style={[
            { width: '100%', borderRadius: 24, backgroundColor: color.surface.base, padding: 24 },
            elevation.floating,
          ]}
        >
          <Heading size="lg">{title}</Heading>
          {body ? <Text className="mt-2 text-sm text-text-secondary">{body}</Text> : null}
          <View className="mt-6 flex-row" style={{ gap: 10 }}>
            <Button variant="neutral" className="flex-1" label={cancelLabel} onPress={onClose} disabled={loading} />
            <Button
              className="flex-1"
              label={confirmLabel}
              loading={loading}
              onPress={onConfirm}
              style={destructive ? { backgroundColor: color.error } : undefined}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
