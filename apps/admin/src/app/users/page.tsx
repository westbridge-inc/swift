'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchUsers } from '@/lib/api';

export default function UsersPage() {
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => fetchUsers() });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Users</h1>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Name</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Email</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Phone</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Role</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">No users found</td></tr>
            ) : (
              data?.data?.map((user: any) => (
                <tr key={user.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-medium">{user.firstName} {user.lastName}</td>
                  <td className="p-4">{user.email}</td>
                  <td className="p-4">{user.phone || '\u2014'}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 rounded-full text-xs bg-white/10">{user.role}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      user.isActive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                    }`}>{user.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4 text-right text-[#8E8E93]">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
