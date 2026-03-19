'use client';

import { Bell, Search } from 'lucide-react';

export function Header() {
  return (
    <header className="h-16 bg-[#1C1C1E] border-b border-[#38383A] flex items-center justify-between px-6">
      <div className="relative w-96">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8E8E93]" size={18} />
        <input
          type="text"
          placeholder="Search orders, users, vendors..."
          className="w-full bg-[#2C2C2E] text-white pl-10 pr-4 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#FF6B00] focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-4">
        <button className="relative p-2 text-[#8E8E93] hover:text-white transition-colors">
          <Bell size={20} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-[#FF6B00] rounded-full" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#FF6B00] flex items-center justify-center text-sm font-bold">
            SA
          </div>
          <span className="text-sm">Swift Admin</span>
        </div>
      </div>
    </header>
  );
}
