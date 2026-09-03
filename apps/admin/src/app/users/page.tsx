'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchUsers, suspendUser, unsuspendUser, type AdminUser } from '@/lib/api';
import { askReason } from '@/lib/ask-reason';

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: 'bg-green-500/20 text-green-400',
  SUSPENDED: 'bg-red-500/20 text-red-400',
};

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => fetchUsers() });
  const suspendMutation = useMutation({
    // [ADM-006] The reason was the constant 'Suspended by admin' — a field,
    // not an explanation. The operator states one, or nothing happens.
    mutationFn: ({ id, suspended, reason }: { id: string; suspended: boolean; reason: string }) =>
      suspended ? unsuspendUser(id) : suspendUser(id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Users</h1>
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Name</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Email</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Phone</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Role</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Joined</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center text-[var(--muted)]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-[var(--muted)]">No users found</td></tr>
            ) : (
              data?.data?.map((user: AdminUser) => (
                <tr key={user.id} className="border-b border-[var(--border)] hover:bg-white/5">
                  <td className="p-4 font-medium"><Link href={`/users/${user.id}`} className="hover:text-[var(--accent)] transition-colors">{user.firstName} {user.lastName}</Link></td>
                  <td className="p-4">{user.email}</td>
                  <td className="p-4">{user.phone || '\u2014'}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 rounded-full text-xs bg-white/10">{(user.activeRole ?? '—').toLowerCase().replace(/_/g, ' ')}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${STATUS_CLASS[user.status] ?? 'bg-white/10 text-[var(--muted)]'}`}>
                      {(user.status ?? 'UNKNOWN').toLowerCase()}
                    </span>
                  </td>
                  <td className="p-4 text-right text-[var(--muted)]">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="p-4 text-right">
                    {user.status === 'SUSPENDED' ? (
                      <button
                        onClick={() => { const reason = askReason({ action: 'unsuspend this account', subject: `${user.firstName} ${user.lastName}` }); if (reason) suspendMutation.mutate({ id: user.id, suspended: true, reason }); }}
                        disabled={suspendMutation.isPending}
                        className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] text-white hover:bg-white/10 disabled:opacity-50"
                      >
                        Unsuspend
                      </button>
                    ) : user.status === 'ACTIVE' ? (
                      <button
                        onClick={() => { const reason = askReason({ action: 'suspend this account', subject: `${user.firstName} ${user.lastName}` }); if (reason) suspendMutation.mutate({ id: user.id, suspended: false, reason }); }}
                        disabled={suspendMutation.isPending}
                        className="px-3 py-1 rounded-lg text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent)]/80 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
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
