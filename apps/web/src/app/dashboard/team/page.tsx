'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStores, type Store } from '@/lib/vendor-api';
import { addStaff, getStaff, removeStaff, updateStaffRole, type StaffMember } from '@/lib/branches-api';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { useStepUp, isStepUpDismissed } from '@/lib/step-up';
import { TEAM_ROLE_WORDS, branchLabel } from '@/lib/branches';
import { DataUnavailable } from '@/components/data-unavailable';

const errorWords = (e: unknown, fallback: string) => (!e || isStepUpDismissed(e) ? null : e instanceof Error && e.message ? e.message : fallback);

/**
 * [CHAINS PR2 · owner 29 Oct 2026] The team, on the website (the phone's Account > Team, its words). The owner adds
 * a person by the phone of their Swift account, as Staff (orders and availability) or Manager, and, with several
 * branches, to several branches in ONE step (one add from the daily allowance, however many branches). Changing a
 * role and adding someone ask this browser to confirm it's you (lib/step-up). The list is the selected branch's.
 */
export default function TeamPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const { role, known } = useStoreRole();
  const owner = role === 'OWNER';
  const stepUp = useStepUp();
  const staff = useQuery({ queryKey: storeKey(storeId, 'staff'), queryFn: getStaff, enabled: owner });
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores, enabled: owner });
  // [REVIEW-F #2220 S4-3] Only branches open on Swift (ACTIVE): the server refuses the whole add for any other.
  const others: Store[] = useMemo(() => (stores.data?.stores ?? []).filter((s) => s.id !== storeId && s.status === 'ACTIVE'), [stores.data?.stores, storeId]);
  const [phone, setPhone] = useState('');
  const [memberRole, setMemberRole] = useState<'MANAGER' | 'STAFF'>('STAFF');
  const [also, setAlso] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'staff') });

  const add = useMutation({
    mutationFn: () => {
      const extra = [...also].filter((id) => others.some((s) => s.id === id));
      const body = { phone: phone.trim(), role: memberRole, ...(extra.length ? { vendorIds: [storeId!, ...extra] } : {}) };
      return stepUp.withStepUp(() => addStaff(body))();
    },
    onMutate: () => setNotice(null),
    onSuccess: (data) => { setPhone(''); setAlso(new Set()); setNotice(data?.message ?? 'If this number has a Swift account, they will get an invite to join your team.'); void refresh(); },
  });
  const changeRole = useMutation({
    mutationFn: (m: StaffMember) => stepUp.withStepUp(() => updateStaffRole(m.id, m.role === 'MANAGER' ? 'STAFF' : 'MANAGER'))(),
    onSettled: () => void refresh(),
  });
  const remove = useMutation({ mutationFn: (id: string) => removeStaff(id), onSettled: () => void refresh() });

  if (known && !owner) return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">The team is managed by the store owner.</p>;
  const members = staff.data ?? [];
  const addError = errorWords(add.error, 'Couldn’t add them. Try again.');
  const roleError = errorWords(changeRole.error, 'Couldn’t change the role. Try again.');
  const removeError = errorWords(remove.error, 'Couldn’t remove them. Try again.');
  const ok = phone.trim().length >= 10;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="sw-title">Team</h1>
        <p className="sw-caption mt-1">The people who work in this branch with their own Swift login.</p>
      </div>
      <section aria-labelledby="team-list" className="sw-card p-5">
        <h2 id="team-list" className="text-base font-bold">Team members</h2>
        {staff.isError && <DataUnavailable what="your team" error={staff.error} onRetry={() => void staff.refetch()} />}
        {staff.isSuccess && members.length === 0 && <p className="mt-2 text-sm text-[var(--swift-muted)]">No team members yet — add your manager or floor staff by phone.</p>}
        <ul className="mt-3 divide-y divide-[var(--swift-border)]">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{[m.user?.firstName, m.user?.lastName].filter(Boolean).join(' ') || 'Team member'}</p>
                <p className="text-xs text-[var(--swift-muted)]">{m.user?.phone ?? ''}</p>
              </div>
              <button type="button" className="sw-chip" disabled={changeRole.isPending} aria-label={`Change ${m.user?.firstName ?? 'this person'}'s role`} onClick={() => changeRole.mutate(m)}>
                {TEAM_ROLE_WORDS[m.role] ?? 'Staff'}
              </button>
              <button type="button" className="text-sm font-semibold text-[var(--swift-muted)]" onClick={() => setRemoving(m)}>Remove</button>
            </li>
          ))}
        </ul>
        {members.length > 0 && <p className="mt-2 text-xs text-[var(--swift-muted)]">Tap a role to switch between Manager and Staff.</p>}
        {roleError && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{roleError}</p>}
        {removeError && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{removeError}</p>}
      </section>

      <section aria-labelledby="team-add" className="sw-card space-y-3 p-5">
        <h2 id="team-add" className="text-base font-bold">Add a person</h2>
        <label className="block text-sm font-semibold">Their phone
          <input className="mt-1 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-sm" inputMode="tel" placeholder="+592 phone of an existing Swift account" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Role">
          <button type="button" role="radio" aria-checked={memberRole === 'STAFF'} className="sw-chip" onClick={() => setMemberRole('STAFF')}>Staff · queue + availability</button>
          <button type="button" role="radio" aria-checked={memberRole === 'MANAGER'} className="sw-chip" onClick={() => setMemberRole('MANAGER')}>Manager</button>
        </div>
        {others.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">Also add them to these branches</legend>
            {others.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-[var(--swift-red)]" checked={also.has(s.id)}
                  onChange={(e) => setAlso((a) => { const n = new Set(a); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                {branchLabel(s)}
              </label>
            ))}
            <p className="text-xs text-[var(--swift-muted)]">One person added to several branches counts once toward today&apos;s adds.</p>
          </fieldset>
        )}
        {addError && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{addError}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <button type="button" className="sw-btn sw-btn-md" disabled={!ok || add.isPending} onClick={() => add.mutate()}>
          {!ok ? 'Enter their +592 phone' : add.isPending ? 'Adding…' : 'Add to team'}
        </button>
      </section>

      {removing && (
        <div role="alertdialog" aria-labelledby="team-remove" className="sw-card space-y-3 p-5">
          <h2 id="team-remove" className="text-base font-bold">Remove team member?</h2>
          <p className="text-sm text-[var(--swift-muted)]">{removing.user?.firstName ?? 'This person'} will lose store access immediately.</p>
          <div className="flex gap-2">
            <button type="button" className="sw-btn sw-btn-md" disabled={remove.isPending} onClick={() => { const id = removing.id; setRemoving(null); remove.mutate(id); }}>Remove</button>
            <button type="button" className="sw-chip" onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </div>
      )}
      {stepUp.dialog}
    </div>
  );
}
