'use client';

import { confirmPhoneChange, startPhoneChange } from '@/lib/api';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import type { Outcome } from '@/lib/outcome';

/**
 * [BUG-HUNT F22] A person whose SIM or number changed had no door anywhere: the number is their sign-in. Asking goes to
 * a second admin, because this hands over a whole account. Once it is approved and applied from Approvals, a code goes
 * to the new number, and the person reads it back here. Every session ends, and the old number is told. The page does
 * not offer this on a staff account: the server refuses it for everyone.
 */
export function PhoneChangeAction({ userId, name, onResult }: { userId: string; name: string; onResult: (_outcome: Outcome | null) => void }) {
  const dialog = useActionDialog();
  const ask = async () => {
    onResult(await dialog.run({
      title: `Move ${name} to a new number?`,
      body: <p>A second admin has to approve this first. Once it is approved and applied, a code goes to the new number. Nothing changes until the person reads it back.</p>,
      confirmLabel: 'Ask a second admin',
      fields: [{ kind: 'text', name: 'phone', label: 'New number', required: true, minLength: 7, maxLength: 20 }],
      reason: { hint: 'How you know this is the person. Kept on the permanent record.' },
      submit: ({ reason, values }) => startPhoneChange(userId, String(values['phone']), reason),
      success: () => 'The code is on its way to the new number.',
    }));
  };
  const readBack = async () => {
    onResult(await dialog.run({
      title: 'What code did they read back?',
      body: <p>Once it matches, the account moves to the new number. Every session ends and the old number is told.</p>,
      confirmLabel: 'Move the account',
      fields: [{ kind: 'text', name: 'code', label: 'Code', required: true, minLength: 6, maxLength: 6, pattern: /^\d{6}$/ }],
      reason: { hint: 'Kept on the permanent record.' },
      submit: ({ reason, values }) => confirmPhoneChange(userId, String(values['code']), reason),
      success: () => `${name} now signs in with the new number.`,
    }));
  };
  return (
    <>
      <button type="button" className="mc-btn" onClick={() => void ask()}>Change number…</button>
      <button type="button" className="mc-btn" onClick={() => void readBack()}>Enter number code…</button>
    </>
  );
}
