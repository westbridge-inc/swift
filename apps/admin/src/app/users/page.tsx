'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchUsers, suspendUser, unsuspendUser, type AdminUser } from '@/lib/api';
import { ENUM_LABELS, label } from '@/lib/labels';
import { EMPTY_LIST_STATE, listQueryString, type ListState } from '@/lib/list-query';
import { maskedPhone } from '@/lib/review-center';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { ListToolbar, Pager } from '@/components/mc/ListControls';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] People.
//
// The list used to fetch page 1 of 20 with no search, showed full phone
// numbers, printed roles as enums, rendered a failed read as an empty table,
// and suspended through a browser prompt that dropped the server's refusal
// (a role-hierarchy 403). Now: server paging, search and filters, test data
// hidden by default, masked phones (the full number is on the person's page),
// plain words, and every answer shown.
// ---------------------------------------------------------------------------

const asOptions = (group: 'UserRole' | 'UserStatus', all: string): Array<[string, string]> =>
  [['', all], ...Object.entries(ENUM_LABELS[group]).map(([v, w]): [string, string] => [v, w])];

const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function UsersPage() {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  const [result, setResult] = useState<Outcome | null>(null);
  const list = useQuery({
    queryKey: ['users', state],
    queryFn: () => fetchUsers(listQueryString(state)),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];

  const act = async (user: AdminUser, suspend: boolean) => {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'this account';
    const outcome = await dialog.run({
      title: suspend ? `Suspend ${name}?` : `Unsuspend ${name}?`,
      body: <p>{suspend ? 'They are signed out and cannot use Swift until the account is unsuspended.' : 'They can sign in and use Swift again.'}</p>,
      confirmLabel: suspend ? 'Suspend account' : 'Unsuspend account',
      reason: { hint: 'Kept on the permanent record.' },
      submit: ({ reason }) => (suspend ? suspendUser(user.id, reason) : unsuspendUser(user.id, reason)),
      success: () => (suspend ? `${name} is suspended.` : `${name} can use Swift again.`),
    });
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>People</h1>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-4" />
      <ListToolbar
        state={state}
        onChange={setState}
        searchLabel="Search by name, phone or email"
        filters={[
          { key: 'role', label: 'Role', options: asOptions('UserRole', 'All roles') },
          { key: 'status', label: 'Account', options: asOptions('UserStatus', 'Any status') },
        ]}
      />
      {list.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading people…</div>
      ) : list.isError ? (
        <QueryFailed error={list.error} what="the people list" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          <DataTable<AdminUser>
            label="People"
            rows={rows}
            rowKey={(u) => u.id}
            empty={state.search || Object.values(state.filters).some(Boolean) ? 'Nobody matches this search.' : 'No accounts yet.'}
            columns={[
              {
                key: 'name', header: 'Name', width: '28%', primary: true,
                cell: (u) => (
                  <Link href={`/users/${u.id}`} className="block min-w-0">
                    <Truncate text={[u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed account'} />
                    {u.email ? <span className="mc-cell-sub"><Truncate text={u.email} /></span> : null}
                  </Link>
                ),
              },
              { key: 'phone', header: 'Phone', width: '16%', cell: (u) => <span className="mc-numbers">{maskedPhone(u.phone)}</span> },
              { key: 'role', header: 'Role', width: '16%', cell: (u) => label('UserRole', u.activeRole) },
              { key: 'status', header: 'Account', width: '14%', cell: (u) => <StatusBadge group="UserStatus" value={u.status} /> },
              { key: 'joined', header: 'Joined', width: '12%', cell: (u) => when(u.createdAt) },
              {
                key: 'actions', header: 'Actions', width: '9.5rem', align: 'right',
                cell: (u) => (u.status === 'ACTIVE' ? (
                  <button type="button" className="mc-btn mc-btn-danger" aria-label={`Suspend ${[u.firstName, u.lastName].filter(Boolean).join(' ')}…`} onClick={() => void act(u, true)}>Suspend…</button>
                ) : u.status === 'SUSPENDED' ? (
                  <button type="button" className="mc-btn" aria-label={`Unsuspend ${[u.firstName, u.lastName].filter(Boolean).join(' ')}…`} onClick={() => void act(u, false)}>Unsuspend…</button>
                ) : null),
              },
            ]}
          />
          <Pager meta={list.data?.meta} shown={rows.length} onPage={(page) => setState({ ...state, page })} onShowTestData={() => setState({ ...state, showTestData: true, page: 1 })} />
        </>
      )}
    </div>
  );
}
