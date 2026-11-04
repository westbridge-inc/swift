'use client';

import { confirmPhoneChange, startPhoneChange } from '@/lib/api';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import type { Outcome } from '@/lib/outcome';

/**
 * [BUG-HUNT F22] A person whose SIM or number changed had no door anywhere: the number is their sign-in. Two steps: a
 * code goes to the NEW number, then the person reads it back. Staff can never point an account at a number nobody there
 * holds. Every session ends, and the old number is told.
 */
export function PhoneChangeAction({ userId, name, onResult }: { userId: string; name: string; onResult: (_outcome: Outcome | null) => void }) {
  const dialog = useActionDialog();
  const start = async () => {
    const sent = await dialog.run({
      title: `Move ${name} to a new number?`,
      body: <p>A code goes to the new number. Ask the person to read it back to you. Nothing changes until they do.</p>,
      confirmLabel: 'Send the code',
      fields: [{ kind: 'text', name: 'phone', label: 'New number', required: true, minLength: 7, maxLength: 20 }],
      reason: { hint: 'How you know this is the person. Kept on the permanent record.' },
      submit: ({ reason, values }) => startPhoneChange(userId, String(values['phone']), reason),
      success: () => 'The code is on its way to the new number.',
    });
    onResult(sent);
    if (sent?.tone !== 'success') return;
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
  return <button type="button" className="mc-btn" onClick={() => void start()}>Change number…</button>;
}
