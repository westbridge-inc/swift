'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomerSession } from '@/components/customer-session';
import { accountApi, type Address } from './account-api';
import { AccountFrame, buttonClass, secondaryClass, useAccountQuery } from './account-frame';
import { AddressForm } from './address-form';
import { DataUnavailable } from '@/components/data-unavailable';

export function SavedAddresses() {
  const addresses = useAccountQuery('addresses', accountApi.addresses);
  const queryClient = useQueryClient();
  const session = useCustomerSession();
  async function refreshAddresses() {
    await Promise.all([addresses.refetch(), queryClient.invalidateQueries({ queryKey: ['customer', 'addresses', session.scope] })]);
  }
  async function savedAddress(saved: Address) {
    const queryKey = ['account', session.scope, session.epoch, 'addresses'];
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<Address[]>(queryKey, (rows = []) => {
      const others = rows.filter((row) => row.id !== saved.id);
      return [...others.map((row) => saved.isDefault ? { ...row, isDefault: false } : row), saved];
    });
    setEditing(null);
    await refreshAddresses();
  }
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [removing, setRemoving] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function change(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      await action(); setRemoving(null);
      // Read the server's default, including its promotion after a deletion.
      await refreshAddresses();
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <AccountFrame title="Saved addresses">
    <p className="text-sm text-[var(--swift-muted)]">Your default is used when your cart has no delivery address selected.</p>
    {addresses.isError ? <DataUnavailable what="your saved addresses" error={addresses.error} onRetry={() => void addresses.refetch()} />
      : !addresses.data ? <p role="status">Loading your addresses…</p>
      : addresses.data.length === 0 ? <p>No addresses yet. Add where deliveries should go.</p>
      : <ul className="space-y-3">{addresses.data.map((address) => <li key={address.id} className="space-y-3 sw-card p-4">
        <h2 className="font-bold">{address.label} {address.isDefault && <span className="ml-2 text-sm text-[var(--swift-red)]">Default</span>}</h2>
        <p>{[address.addressLine1, address.addressLine2, address.city].filter(Boolean).join(', ')}</p>
        {address.instructions && <p className="text-sm text-[var(--swift-muted)]">{address.instructions}</p>}
        <div className="flex flex-wrap gap-2">
          {!address.isDefault && <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => void change(() => accountApi.defaultAddress(address.id))}>Make {address.label} default</button>}
          <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => { setRemoving(null); setEditing(address); }}>Edit {address.label}</button>
          <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => setRemoving(address)}>Remove {address.label}</button>
        </div>
      </li>)}</ul>}
    {removing && <div role="dialog" aria-label={`Remove ${removing.label}?`} className="space-y-3 rounded-2xl border border-[var(--swift-border-strong)] bg-[var(--swift-card)] p-4">
      <p>Remove {removing.label}? {removing.addressLine1}, {removing.city}</p>
      <div className="flex gap-2"><button className={secondaryClass} disabled={busy} onClick={() => setRemoving(null)}>Keep address</button><button className={buttonClass} disabled={busy} onClick={() => void change(() => accountApi.deleteAddress(removing.id))}>Confirm removal</button></div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {editing ? <AddressForm key={editing === 'new' ? 'new' : editing.id} address={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={savedAddress} />
      : <button className={buttonClass} disabled={busy || !addresses.data || addresses.isError} onClick={() => { setRemoving(null); setEditing('new'); }}>Add an address</button>}
  </AccountFrame>;
}
