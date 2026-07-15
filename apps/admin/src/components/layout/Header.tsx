'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { clearTokens } from '@/lib/api';
import { GlobalSearch } from './GlobalSearch';

export function Header() {
  const router = useRouter();

  function handleLogout() {
    clearTokens();
    router.replace('/login');
  }

  return (
    <header className="h-16 bg-[#1C1C1E] border-b border-[#38383A] flex items-center justify-between px-6">
      <GlobalSearch />
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#E8192C] flex items-center justify-center text-sm font-bold">
            SA
          </div>
          <span className="text-sm">Swift Admin</span>
        </div>
        <button
          onClick={handleLogout}
          title="Sign out"
          className="p-2 text-[#8E8E93] hover:text-white transition-colors"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
