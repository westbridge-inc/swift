'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchUsers, suspendUser, unsuspendUser } from '@/lib/api';

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: 'bg-green-500/20 text-green-400',
  SUSPENDED: 'bg-red-500/20 text-red-400',
};

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => fetchUsers() });
  const suspendMutation = useMutation({
    mutationFn: ({ id, suspended }: { id: string; suspended: boolean }) =>
      suspended ? unsuspendUser(id) : suspendUser(id, 'Suspended by admin'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

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
              <th className="text-right p-4 text-[#8E8E93] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">No users found</td></tr>
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
                    <span className={`px-2 py-1 rounded-full text-xs ${STATUS_CLASS[user.status] ?? 'bg-white/10 text-[#8E8E93]'}`}>
                      {(user.status ?? 'UNKNOWN').toLowerCase()}
                    </span>
                  </td>
                  <td className="p-4 text-right text-[#8E8E93]">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="p-4 text-right">
                    {user.status === 'SUSPENDED' ? (
                      <button
                        onClick={() => suspendMutation.mutate({ id: user.id, suspended: true })}
                        disabled={suspendMutation.isPending}
                        className="px-3 py-1 rounded-lg text-xs border border-[#38383A] text-white hover:bg-white/10 disabled:opacity-50"
                      >
                        Unsuspend
                      </button>
                    ) : user.status === 'ACTIVE' ? (
                      <button
                        onClick={() => { if (window.confirm(`Suspend ${user.firstName} ${user.lastName}?`)) suspendMutation.mutate({ id: user.id, suspended: false }); }}
                        disabled={suspendMutation.isPending}
                        className="px-3 py-1 rounded-lg text-xs bg-[#E8192C] text-white hover:bg-[#E8192C]/80 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    ) : (
                      <span className="text-[#8E8E93]">—</span>
                    )}
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
