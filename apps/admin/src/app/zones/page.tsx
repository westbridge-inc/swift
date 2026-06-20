'use client';

import { Map } from 'lucide-react';

export default function ZonesPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Delivery Zones</h1>
      <p className="text-[#8E8E93] text-sm mb-6">
        Today, delivery range is enforced per vendor (each vendor&apos;s delivery radius) and per
        market via CountryConfig. Map-based zones are a planned enhancement.
      </p>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-12 flex flex-col items-center justify-center text-center">
        <Map size={48} className="text-[#8E8E93] mb-4" />
        <h2 className="text-lg font-semibold mb-2">Zone management is on the roadmap</h2>
        <p className="text-[#8E8E93] text-sm max-w-md">
          Map-drawn coverage boundaries and surge-pricing areas aren&apos;t built yet — when they are,
          they&apos;ll appear here. No zones are configured today.
        </p>
      </div>
    </div>
  );
}
