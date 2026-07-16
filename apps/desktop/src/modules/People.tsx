import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchUsers, suspendUser, unsuspendUser } from '../lib/api';

// People (spec §5.4): the unified directory. Suspend requires a reason —
// it lands in the admin audit log server-side.

export default function People() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const users = useQuery({ queryKey: ['people', q], queryFn: () => fetchUsers({ search: q || undefined }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['people'] });
  const suspend = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) => suspendUser(id, why),
    onSettled: refresh,
  });
  const unsuspend = useMutation({ mutationFn: unsuspendUser, onSettled: refresh });

  const rows: any[] = users.data?.rows ?? [];

  return (
    <div className="max-w-4xl space-y-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); }}
        className="flex gap-2"
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone, email…"
          className="w-80 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        <button className="rounded-lg border border-white/15 px-4 py-2 text-sm">Search</button>
      </form>

      {users.isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {users.isError && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <p className="text-sm text-white/60">{(users.error as Error).message}</p>
          <button onClick={() => users.refetch()} className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
        </div>
      )}
      {!users.isLoading && rows.length === 0 && !users.isError && (
        <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-white/40">
          Nobody matches.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((u) => {
          const suspended = u.status === 'SUSPENDED';
          return (
            <div key={u.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || u.phone}
                    <span className="ml-2 text-xs text-white/40">{u.phone}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-white/50">
                    {(u.roles ?? []).join(' · ')} ·{' '}
                    <span className={suspended ? 'text-[var(--swift-red)] font-bold' : 'text-green-400'}>{u.status}</span>
                  </p>
                </div>
                {suspended ? (
                  <button
                    onClick={() => unsuspend.mutate(u.id)}
                    disabled={unsuspend.isPending}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  >
                    Reinstate
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      value={reason[u.id] ?? ''}
                      onChange={(e) => setReason({ ...reason, [u.id]: e.target.value })}
                      placeholder="Reason (required)"
                      className="w-44 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none"
                    />
                    <button
                      onClick={() => suspend.mutate({ id: u.id, why: reason[u.id]!.trim() })}
                      disabled={suspend.isPending || !(reason[u.id] ?? '').trim()}
                      className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    >
                      Suspend
                    </button>
                  </div>
                )}
              </div>
              {(suspend.isError || unsuspend.isError) && (
                <p className="mt-2 text-xs text-[var(--swift-red)]">
                  {((suspend.error ?? unsuspend.error) as Error)?.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
