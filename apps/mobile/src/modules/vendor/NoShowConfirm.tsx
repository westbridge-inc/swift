/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { space } from '@swift/ui';
import { IconChip, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { useMarkNoShow } from '../../hooks/vendorops';
import { NO_SHOW_WORDS, msUntilStart, noShowClosedLine, noShowRefusalWords } from './noShow';

/** The longest wait a timer takes (about 24.8 days); a later start is checked again after it. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * [BOOK-NS-APP] The clock a "Customer didn't come" check reads. A screen left open across the appointment's start
 * draws again at the start, so the button appears then (not at the next read of the order). No time, or a time
 * already started: no timer.
 */
export function useStartClock(iso: unknown): number {
  const now = Date.now();
  const wait = msUntilStart(iso, now);
  const [, redraw] = useState(0);
  const pending = wait !== null && wait > 0;
  const key = typeof iso === 'string' ? iso : iso instanceof Date ? iso.toISOString() : '';
  useEffect(() => {
    if (!pending || wait === null) return undefined;
    const timer = setTimeout(() => redraw((n) => n + 1), Math.min(wait + 50, MAX_TIMER_MS));
    return () => clearTimeout(timer);
    // The wait is read at each draw; the timer follows the time and whether it is still ahead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pending]);
  return now;
}

/**
 * [BOOK-NS-APP · owner B3] The one step before "Customer didn't come" goes to the server, then what the server said.
 * Mounted only while the store is deciding (the order detail and the Schedule mount it on the tap).
 *  - Ask: "Mark as 'Customer didn't come'? The booking closes. No fee, no strike."
 *  - Refused: the server's own words stay on the popup (APPOINTMENT_NOT_STARTED, NO_SHOW_NOT_OPEN, NO_SHOW_PAID_MMG).
 *  - Done: the closed state from the server's answer (when it was recorded).
 */
export function NoShowConfirm({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const mark = useMarkNoShow();
  const close = () => {
    if (mark.isPending) return;
    mark.reset();
    onClose();
  };
  const send = () => {
    if (mark.isPending) return;
    mark.mutate(orderId);
  };

  if (mark.isSuccess) {
    return (
      <PopupCard visible onClose={close}>
        <IconChip icon="check-circle" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          {NO_SHOW_WORDS.closedTitle}
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {noShowClosedLine(mark.data)}
        </T>
        <PillButton label={NO_SHOW_WORDS.done} variant="primary" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={close} />
      </PopupCard>
    );
  }

  return (
    <PopupCard visible onClose={close}>
      <IconChip icon="user-x" size={56} tone="error" />
      <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
        {NO_SHOW_WORDS.confirmTitle}
      </PopupTitle>
      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        {NO_SHOW_WORDS.confirmBody}
      </T>
      {mark.isError ? (
        <T variant="caption" tone="error" center style={{ alignSelf: 'stretch', marginTop: space.md }}>
          {noShowRefusalWords(mark.error)}
        </T>
      ) : null}
      <PillButton
        label={NO_SHOW_WORDS.confirmYes}
        variant="primary"
        style={{ alignSelf: 'stretch', marginTop: space.lg }}
        disabled={mark.isPending}
        loading={mark.isPending}
        onPress={send}
      />
      <PillButton
        label={NO_SHOW_WORDS.keep}
        variant="soft"
        style={{ alignSelf: 'stretch', marginTop: space.md }}
        disabled={mark.isPending}
        onPress={close}
      />
    </PopupCard>
  );
}
