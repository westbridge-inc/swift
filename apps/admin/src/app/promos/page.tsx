'use client';

import { useState, useId, cloneElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchPromos, createPromo, type CreatePromoInput, type Promo } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';

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
  const { data, isLoading, isError, error: readError, refetch, isFetching } = useQuery({ queryKey: ['promos'], queryFn: fetchPromos });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreatePromoInput>(EMPTY);

  // [U62] The form is the shared dialog (focus kept inside, Escape and a click
  // outside close it) and, once anything is typed, only Cancel closes it, so a
  // stray click never throws the typed promo away. Creating it goes through the
  // reason panel: the form steps aside (its values kept) while the panel runs
  // the request once, and comes back if the operator cancels or is refused.
  const actions = useActionRunner(() => {
    void qc.invalidateQueries({ queryKey: ['promos'] });
    setForm(EMPTY);
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY);
  const submit = async () => {
    const body: CreatePromoInput = {
      ...form,
      code: form.code.trim(),
      discountValue: Number(form.discountValue),
      ...(form.minOrderAmount != null ? { minOrderAmount: Number(form.minOrderAmount) } : {}),
      ...(form.maxUses != null ? { maxUses: Number(form.maxUses) } : {}),
    };
    setOpen(false);
    const outcome = await actions.run({
      title: `Create the promo code ${body.code}?`,
      body: (
        <p>
          {body.discountType === 'PERCENTAGE' ? `${body.discountValue}% off` : body.discountType === 'FIXED_AMOUNT' ? `GY$${body.discountValue.toLocaleString()} off` : 'Free delivery'}
          , valid {body.validFrom} to {body.validUntil}{body.maxUses ? `, at most ${body.maxUses} uses` : ''}.
        </p>
      ),
      confirmLabel: 'Create promo code',
      submit: ({ reason }) => createPromo(body, reason),
      success: () => `Promo code ${body.code} created.`,
    });
    if (outcome?.tone !== 'success' && outcome?.tone !== 'queued') setOpen(true);
  };

  const set = (patch: Partial<CreatePromoInput>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="mc-page">
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={() => { actions.clear(); setOpen(true); }}
          className="mc-btn mc-btn-primary"
        >
          Create Promo
        </button>
      </div>

      {actions.banner}
      <div className="mc-table-wrap">
        <table className="mc-table mc-table-auto">
          <thead>
            <tr >
              <th className="mc-label text-left">Code</th>
              <th className="mc-label text-left">Type</th>
              <th className="mc-label text-left">Discount</th>
              <th className="mc-label text-left">Status</th>
              <th className="mc-label text-left">Uses</th>
              <th className="mc-label text-right">Expires</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="mc-table-empty">Loading...</td></tr>
            ) : isError ? (
              <tr><td colSpan={6} className="p-4">
                <QueryFailed error={readError} what="the promo codes" onRetry={() => void refetch()} retrying={isFetching} />
              </td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={6} className="mc-table-empty">No promo codes yet</td></tr>
            ) : (
              data?.data?.map((promo: Promo) => (
                <tr key={promo.id} >
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
                      promo.isActive ? 'bg-[var(--mc-good-soft)] mc-text-good' : 'bg-gray-500/20 text-gray-400'
                    }`}>{promo.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4">{promo.currentUses} / {promo.maxUses || '∞'}</td>
                  <td className="p-4 text-right mc-muted">
                    {promo.validUntil ? new Date(promo.validUntil).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal title="New promo code" onClose={() => setOpen(false)} busy={dirty} overlayTestId="promo-form-overlay">
          <div className="w-full max-w-md bg-[var(--mc-card)] rounded-2xl border border-[var(--mc-line)] p-6">
            <h2 className="text-lg font-semibold mb-4">New promo code</h2>
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
            <div className="flex justify-end gap-3 mt-5">
              <button type="button" onClick={() => setOpen(false)} className="mc-btn mc-btn-quiet">Cancel</button>
              <button type="button" onClick={() => void submit()} disabled={form.code.trim().length < 2 || !form.description.trim()}
                className="mc-btn mc-btn-primary">
                Create
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const inputCls =
  'mc-input mt-1';

// [A-22] The label was rendered but never ASSOCIATED: no `htmlFor`, no `id`, so
// a screen reader announced every one of these as an unnamed edit box and
// clicking the label did nothing. The id is generated here and handed to the
// control, so a caller cannot forget it.
function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mc-muted text-xs">{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
