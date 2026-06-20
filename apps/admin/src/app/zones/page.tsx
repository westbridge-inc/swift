'use client';

import { Map } from 'lucide-react';

export default function ZonesPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Delivery Zones</h1>
        <button className="px-4 py-2 bg-[#E8192C] text-white rounded-lg text-sm hover:bg-[#E8192C]/80">
          Create Zone
        </button>
      </div>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-12 flex flex-col items-center justify-center text-center">
        <Map size={48} className="text-[#8E8E93] mb-4" />
        <h2 className="text-lg font-semibold mb-2">Zone Management</h2>
        <p className="text-[#8E8E93] text-sm max-w-md">
          Configure delivery zones, surge pricing areas, and coverage boundaries for Georgetown and surrounding areas.
          Map integration coming soon.
        </p>
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-2xl">
          <div className="bg-white/5 rounded-lg p-4">
            <p className="text-2xl font-bold">Georgetown</p>
            <p className="text-[#8E8E93] text-xs mt-1">Primary zone</p>
          </div>
          <div className="bg-white/5 rounded-lg p-4">
            <p className="text-2xl font-bold">East Bank</p>
            <p className="text-[#8E8E93] text-xs mt-1">Extended zone</p>
          </div>
          <div className="bg-white/5 rounded-lg p-4">
            <p className="text-2xl font-bold">East Coast</p>
            <p className="text-[#8E8E93] text-xs mt-1">Extended zone</p>
          </div>
        </div>
      </div>
    </div>
  );
}
