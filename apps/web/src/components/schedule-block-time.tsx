'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/modal';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { createBookingException } from '@/lib/booking-api';
import { formatAppointmentDay } from '@/lib/appointmentTime';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The Schedule tab's "Block time" dialog (all day or a window). The page loads it
 *  only when it opens, so the tab's first load does not carry the dialog. */
export default function BlockTimeDialog({ dayKey, onClose }: { dayKey: string; onClose: () => void }) {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const [fullDay, setFullDay] = useState(true);
  const [blockStart, setBlockStart] = useState('13:00');
  const [blockEnd, setBlockEnd] = useState('17:00');
  const [note, setNote] = useState('');
  const blockValid = fullDay || (HHMM.test(blockStart) && HHMM.test(blockEnd) && blockStart < blockEnd);
  const addBlock = useMutation({
    mutationFn: () => createBookingException({
      date: dayKey,
      ...(fullDay ? {} : { start: blockStart, end: blockEnd }),
      ...(note.trim() ? { reason: note.trim() } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'booking-exceptions') });
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'bookings') });
      onClose();
    },
  });
  return (
    <Modal labelledBy="block-time-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="block-time-title" className="sw-title text-center">Block time</h2>
      <p className="sw-caption mt-1 text-center">{formatAppointmentDay(dayKey)}. Customers won&apos;t see these slots. Nothing is shown as a reason.</p>
      <div className="mt-5 flex items-center justify-between">
        <span id="block-all-day" className="text-sm">All day</span>
        <button type="button" role="switch" aria-labelledby="block-all-day" aria-checked={fullDay} onClick={() => setFullDay((v) => !v)}
          className="grid h-11 w-16 flex-none place-items-center" data-modal-initial-focus>
          <span className={`sw-stock-switch ${fullDay ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${fullDay ? 'translate-x-5' : ''}`} /></span>
        </button>
      </div>
      {!fullDay && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="sw-field-label">From</span>
            <input type="time" className="sw-input" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="sw-field-label">Until</span>
            <input type="time" className="sw-input" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
          </label>
        </div>
      )}
      <label className="mt-3 block">
        <span className="sw-field-label">Note (only you see this)</span>
        <input className="sw-input" value={note} maxLength={200} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
      </label>
      <MutationNotice errors={[addBlock.error]} className="mt-3" />
      {/* [#947's grammar] Disabled says the ask. */}
      <button type="button" className="sw-btn sw-btn-block mt-5" disabled={!blockValid || addBlock.isPending} onClick={() => addBlock.mutate()}>
        {addBlock.isPending ? 'Blocking…' : blockValid ? 'Block time' : 'Times must be HH:MM, start before end'}
      </button>
      <button type="button" className="sw-btn sw-btn-outline sw-btn-block mt-2" onClick={onClose}>Cancel</button>
    </Modal>
  );
}
