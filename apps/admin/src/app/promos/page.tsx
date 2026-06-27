'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchPromos, createPromo, type CreatePromoInput, type Promo } from '@/lib/api';

const EMPTY: CreatePromoInput = {
  code: '',
  description: '',
  discountType: 'PERCENTAGE',
  discountValue: 10,
  validFrom: new Date().toISOString().slice(0, 10),
  validUntil: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
};

export default function PromosPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['promos'], queryFn: fetchPromos });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreatePromoInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createPromo({
        ...form,
        code: form.code.trim(),
        discountValue: Number(form.discountValue),
        ...(form.minOrderAmount != null ? { minOrderAmount: Number(form.minOrderAmount) } : {}),
        ...(form.maxUses != null ? { maxUses: Number(form.maxUses) } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promos'] });
      setOpen(false);
      setForm(EMPTY);
      setError(null);
    },
    onError: (e) => setError((e as Error).message || 'Could not create promo.'),
  });

  const set = (patch: Partial<CreatePromoInput>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Promo Codes</h1>
        <button
          onClick={() => { setError(null); setOpen(true); }}
          className="px-4 py-2 bg-[#E8192C] text-white rounded-lg text-sm hover:bg-[#E8192C]/80"
        >
          Create Promo
        </button>
      </div>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Code</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Discount</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Uses</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Expires</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">No promo codes yet</td></tr>
            ) : (
              data?.data?.map((promo: Promo) => (
                <tr key={promo.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-mono font-medium">{promo.code}</td>
                  <td className="p-4">{promo.discountType}</td>
                  <td className="p-4">
                    {promo.discountType === 'PERCENTAGE'
                      ? `${promo.discountValue}%`
                      : promo.discountType === 'FREE_DELIVERY'
                        ? 'Free delivery'
                        : `$${Number(promo.discountValue).toLocaleString()}`}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      promo.isActive ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>{promo.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4">{promo.currentUses} / {promo.maxUses || '∞'}</td>
                  <td className="p-4 text-right text-[#8E8E93]">
                    {promo.validUntil ? new Date(promo.validUntil).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md bg-[#1C1C1E] rounded-2xl border border-[#38383A] p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">New Promo Code</h2>
            <div className="space-y-3">
              <Field label="Code">
                <input value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })}
                  placeholder="WELCOME10" className={inputCls} />
              </Field>
              <Field label="Description">
                <input value={form.description} onChange={(e) => set({ description: e.target.value })}
                  placeholder="10% off your first order" className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                  <select value={form.discountType} onChange={(e) => set({ discountType: e.target.value as CreatePromoInput['discountType'] })} className={inputCls}>
                    <option value="PERCENTAGE">Percentage</option>
                    <option value="FIXED_AMOUNT">Fixed amount</option>
                    <option value="FREE_DELIVERY">Free delivery</option>
                  </select>
                </Field>
                <Field label={form.discountType === 'PERCENTAGE' ? 'Value (%)' : 'Value (GYD)'}>
                  <input type="number" step="any" value={form.discountValue}
                    onChange={(e) => set({ discountValue: Number(e.target.value) })} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Valid from">
                  <input type="date" value={form.validFrom} onChange={(e) => set({ validFrom: e.target.value })} className={inputCls} />
                </Field>
                <Field label="Valid until">
                  <input type="date" value={form.validUntil} onChange={(e) => set({ validUntil: e.target.value })} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Min order (GYD, optional)">
                  <input type="number" step="any" value={form.minOrderAmount ?? ''} onChange={(e) => set({ minOrderAmount: e.target.value === '' ? undefined : Number(e.target.value) })} className={inputCls} />
                </Field>
                <Field label="Max uses (optional)">
                  <input type="number" value={form.maxUses ?? ''} onChange={(e) => set({ maxUses: e.target.value === '' ? undefined : Number(e.target.value) })} className={inputCls} />
                </Field>
              </div>
            </div>
            {error && <p className="mt-3 text-sm text-[#E8192C]">{error}</p>}
            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm text-[#8E8E93] hover:text-white">Cancel</button>
              <button onClick={() => create.mutate()} disabled={create.isPending || form.code.trim().length < 2 || !form.description.trim()}
                className="px-5 py-2 bg-[#E8192C] text-white rounded-lg text-sm font-medium hover:bg-[#E8192C]/80 disabled:opacity-50">
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'mt-1 w-full bg-[#2C2C2E] text-white px-3 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-[#8E8E93]">{label}</label>
      {children}
    </div>
  );
}
