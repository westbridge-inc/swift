import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { PopupCard, PillButton, T } from '../../kit';

/** Fires exactly once when a "live" flag is OBSERVED flipping false → true —
 *  the approval moment. Opening the app already-approved stays quiet. */
export function useWentLive(isLive: boolean | undefined) {
  const prev = useRef<boolean | undefined>(undefined);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (prev.current === false && isLive === true) setCelebrate(true);
    if (isLive !== undefined) prev.current = isLive;
  }, [isLive]);
  return { celebrate, dismiss: () => setCelebrate(false) };
}

export function WentLivePopup({
  visible,
  onClose,
  kind,
}: {
  visible: boolean;
  onClose: () => void;
  kind: 'mover' | 'vendor';
}) {
  return (
    <PopupCard visible={visible} onClose={onClose}>
      <View style={{ alignItems: 'center' }}>
        <MaterialCommunityIcons name="party-popper" size={40} color={color.brand[500]} />
        <T variant="title" center style={{ marginTop: 8 }}>
          You&apos;re approved — you&apos;re live!
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: 6 }}>
          {kind === 'mover'
            ? 'Your documents passed review. Go online whenever you’re ready to start earning.'
            : 'Your business passed review. Add your menu, open the store, and the orders start here.'}
        </T>
        <PillButton label={kind === 'mover' ? 'Start earning' : 'Open my store'} size="md" style={{ marginTop: 14, alignSelf: 'stretch' }} onPress={onClose} />
      </View>
    </PopupCard>
  );
}
