'use client';

import { AlertTriangle, AlertCircle } from 'lucide-react';

export function AlertsPanel() {
  // TODO: Connect to real data
  const alerts = [
    { level: 'warning', message: '3 orders unassigned for > 10 minutes' },
    { level: 'warning', message: '5 subscriptions past due' },
    { level: 'warning', message: '2 vendors pending approval' },
    { level: 'error', message: '1 rider complaint escalated' },
  ];

  return (
    <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
      <h3 className="text-lg font-semibold mb-4">Alerts & Issues</h3>
      <div className="space-y-2">
        {alerts.map((alert, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
            {alert.level === 'error' ? (
              <AlertCircle size={16} className="text-red-400 shrink-0" />
            ) : (
              <AlertTriangle size={16} className="text-yellow-400 shrink-0" />
            )}
            <span className="text-sm">{alert.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
