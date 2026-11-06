'use client';

import { X } from 'lucide-react';
import { Pictogram } from '@/components/glyphs';
import { Modal } from '@/components/modal';

/** [PERF · 6 Nov 2026] The home's "Scan a store's Swift code" help, loaded on the tap that opens it (customer-home.tsx). */
export default function ScanHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal labelledBy="scan-help-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-[var(--swift-red-50)] text-[var(--swift-red-600)]"><Pictogram name="scan" size={24} /></span>
          <div className="flex-1">
            <h2 id="scan-help-title" className="sw-title">Scan a store’s Swift code</h2>
            <p className="sw-caption mt-1 text-[15px] leading-[22px]">Point your phone’s camera at the Swift code on a store’s counter or flyer. It opens that store here, ready to order.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
        </div>
        <button type="button" onClick={onClose} className="sw-btn sw-btn-block mt-5">Got it</button>
    </Modal>
  );
}
