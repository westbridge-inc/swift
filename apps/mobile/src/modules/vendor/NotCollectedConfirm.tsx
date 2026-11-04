/** @jsxImportSource react */
import React from 'react';
import { space } from '@swift/ui';
import { IconChip, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { useMarkNotCollected } from '../../hooks/vendorops';
import { NOT_COLLECTED_WORDS, notCollectedRefusalWords, notCollectedSentToSupport } from './notCollected';

/**
 * [BUG-HUNT-2 G20] The one step before "Not collected" goes to the server, then what the server said. Mounted only while the
 * store is deciding. A refusal stays on the popup in the server's words; the answer says whether the order closed or went
 * to Swift support.
 */
export function NotCollectedConfirm({ orderId, goesToSupport, onClose }: { orderId: string; goesToSupport: boolean; onClose: () => void }) {
  const mark = useMarkNotCollected();
  const close = () => {
    if (mark.isPending) return;
    mark.reset();
    onClose();
  };

  if (mark.isSuccess) {
    const support = notCollectedSentToSupport(mark.data);
    return (
      <PopupCard visible onClose={close}>
        <IconChip icon="check-circle" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          {support ? NOT_COLLECTED_WORDS.supportTitle : NOT_COLLECTED_WORDS.closedTitle}
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {support ? NOT_COLLECTED_WORDS.supportLine : NOT_COLLECTED_WORDS.closedLine}
        </T>
        <PillButton label={NOT_COLLECTED_WORDS.done} variant="primary" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={close} />
      </PopupCard>
    );
  }

  return (
    <PopupCard visible onClose={close}>
      <IconChip icon="user-x" size={56} tone="error" />
      <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
        {NOT_COLLECTED_WORDS.confirmTitle}
      </PopupTitle>
      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        {goesToSupport ? NOT_COLLECTED_WORDS.confirmBodySupport : NOT_COLLECTED_WORDS.confirmBody}
      </T>
      {mark.isError ? (
        <T variant="caption" tone="error" center style={{ alignSelf: 'stretch', marginTop: space.md }}>
          {notCollectedRefusalWords(mark.error)}
        </T>
      ) : null}
      <PillButton
        label={NOT_COLLECTED_WORDS.confirmYes}
        variant="primary"
        style={{ alignSelf: 'stretch', marginTop: space.lg }}
        disabled={mark.isPending}
        loading={mark.isPending}
        onPress={() => { if (!mark.isPending) mark.mutate(orderId); }}
      />
      <PillButton
        label={NOT_COLLECTED_WORDS.keep}
        variant="soft"
        style={{ alignSelf: 'stretch', marginTop: space.md }}
        disabled={mark.isPending}
        onPress={close}
      />
    </PopupCard>
  );
}
