'use client';

import { FileText } from 'lucide-react';

export default function AuditPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Audit Log</h1>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-12 flex flex-col items-center justify-center text-center">
        <FileText size={48} className="text-[#8E8E93] mb-4" />
        <h2 className="text-lg font-semibold mb-2">Audit Trail</h2>
        <p className="text-[#8E8E93] text-sm max-w-md">
          Track all admin actions including vendor approvals, config changes, rider verifications,
          and order modifications. Full audit logging coming soon.
        </p>
        <div className="mt-8 w-full max-w-2xl">
          <div className="space-y-2">
            {[
              { action: 'Vendor approved', user: 'admin@swift.gy', time: '2 min ago', detail: 'Caribbean Delight' },
              { action: 'Config updated', user: 'admin@swift.gy', time: '15 min ago', detail: 'markupPercentage: 15 -> 18' },
              { action: 'Rider verified', user: 'admin@swift.gy', time: '1 hour ago', detail: 'John D. documents approved' },
              { action: 'Promo created', user: 'admin@swift.gy', time: '3 hours ago', detail: 'LAUNCH50 - 50% off' },
              { action: 'Order refunded', user: 'admin@swift.gy', time: '5 hours ago', detail: 'Order #SW-1042 - $3,500 GYD' },
            ].map((entry, i) => (
              <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-white/5 text-left">
                <div className="w-2 h-2 rounded-full bg-[#FF6B00] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{entry.action}</p>
                  <p className="text-xs text-[#8E8E93]">{entry.detail}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-[#8E8E93]">{entry.user}</p>
                  <p className="text-xs text-[#8E8E93]">{entry.time}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
