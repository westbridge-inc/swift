import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActionResult } from './ActionResult';
import { QueryFailed } from './QueryFailed';
import { Truncate } from './Truncate';
import { DataTable } from './DataTable';
import { StatusBadge } from './StatusBadge';
import { ReasonDialogProvider, useActionDialog, useAskReason, type ActionDialogApi } from './ReasonDialog';
import type { Outcome } from '@/lib/outcome';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] The primitives every migrated page will lean on.
// ---------------------------------------------------------------------------

const REASON = 'Checked the owner ID and the food licence against the originals';

/** A thrown answer shaped exactly as apiFetch throws it. */
function serverError(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}

describe('[MC-PR1] <ActionResult>', () => {
  it('a refusal: the words, the server sentence, the next step, the link — and the code only in small print', () => {
    const outcome: Outcome = {
      tone: 'refused', title: 'Approve the required documents in Verification first',
      serverMessage: "Target Store's required documents are not all approved.", next: 'Nothing was changed.',
      link: { label: 'Open in Review Center', href: '/verification?applicant=u1' }, code: 'CHECKLIST_INCOMPLETE', status: 409,
    };
    render(<ActionResult outcome={outcome} />);
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.mc-result-title')?.textContent).toBe('Approve the required documents in Verification first');
    expect(alert.textContent).toContain('Nothing was changed.');
    expect(within(alert).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=u1');
    expect(alert.querySelector('.mc-result-code')?.textContent).toBe('Code CHECKLIST_INCOMPLETE · HTTP 409');
  });

  it('success and queued are polite statuses, not alarms', () => {
    const { rerender } = render(<ActionResult outcome={{ tone: 'success', title: 'Done.' }} />);
    expect(screen.getByRole('status').textContent).toContain('Done.');
    rerender(<ActionResult outcome={{ tone: 'queued', title: "Sent for a second admin's approval", approvalId: 'apr_1', code: 'APPROVAL_REQUIRED', status: 202 }} />);
    expect(screen.getByRole('status').textContent).toContain('Approval apr_1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing for no outcome, and can be dismissed', async () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(<ActionResult outcome={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<ActionResult outcome={{ tone: 'success', title: 'Done.' }} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss this message' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('[MC-PR1] <QueryFailed>', () => {
  it('"Couldn\'t load …", why in words, Retry, and the code for support', async () => {
    const onRetry = vi.fn();
    render(<QueryFailed error={serverError(403, 'FORBIDDEN', 'This admin action requires the vendor.read capability')} what="the store list" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the store list");
    expect(alert.textContent).toContain("You don't have permission to see this");
    expect(alert.textContent).toContain('Code FORBIDDEN · HTTP 403');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('a dropped connection on a read is not "nothing here"', () => {
    render(<QueryFailed error={new TypeError('Failed to fetch')} what="this store" />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't reach Swift's server");
  });
});

describe('[MC-PR1] <Truncate>, <StatusBadge>, <DataTable>', () => {
  it('Truncate keeps the whole text in the DOM and the title, and clamps by class', () => {
    const long = 'A Store With A Very Long Name That Would Have Wrapped Mid Word';
    render(<><Truncate text={long} /><Truncate text={long} lines={2} focusable /></>);
    const [one, two] = screen.getAllByText(long);
    expect(one!.className).toContain('mc-truncate');
    expect(one!.getAttribute('title')).toBe(long);
    expect(one!.hasAttribute('tabindex')).toBe(false);
    expect(two!.getAttribute('data-lines')).toBe('2');
    expect(two!.getAttribute('tabindex')).toBe('0');
  });

  it('StatusBadge shows the words with a tone, never the enum', () => {
    render(<StatusBadge group="VendorStatus" value="PENDING_APPROVAL" />);
    const badge = screen.getByText('Waiting for approval');
    expect(badge.className).toContain('mc-tone-warn');
  });

  it('DataTable labels every cell for the phone layout and says what an empty list means', () => {
    const { rerender } = render(
      <DataTable label="Things" rows={[{ id: '1', name: 'One' }]} rowKey={(r) => r.id} empty="Nothing yet."
        columns={[{ key: 'name', header: 'Name', primary: true, cell: (r) => r.name }, { key: 'id', header: 'Id', cell: (r) => r.id }]} />,
    );
    const table = screen.getByRole('table', { name: 'Things' });
    const cells = within(table).getAllByRole('cell');
    expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(['Name', 'Id']);
    expect(cells[0]!.hasAttribute('data-primary')).toBe(true);
    rerender(<DataTable label="Things" rows={[]} rowKey={(r: { id: string }) => r.id} empty="Nothing yet." columns={[{ key: 'id', header: 'Id', cell: (r) => r.id }]} />);
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
  });

  it('the stylesheet carries the truncation and the ≤ 640 px card layout (no sideways scroll at 390 px)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.mc-truncate \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.mc-table \{[^}]*table-layout: fixed;/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.mc-table, \.mc-table tbody, \.mc-table tr, \.mc-table td \{ display: block;/);
    expect(css).toMatch(/\.mc-table td::before \{ content: attr\(data-label\)/);
  });
});

// ── The reason panel ─────────────────────────────────────────────────────────

let api: ActionDialogApi | null = null;
let ask: ((_p: { action: string; subject?: string }) => Promise<string | null>) | null = null;
function Harness() {
  api = useActionDialog();
  ask = useAskReason();
  const [n] = useState(0);
  return <button type="button">behind the panel {n}</button>;
}
function mount() {
  const user = userEvent.setup();
  render(<ReasonDialogProvider><Harness /></ReasonDialogProvider>);
  return user;
}

describe('[MC-PR1] <ReasonDialog> validation', () => {
  it('is a labelled dialog that starts in the reason box', async () => {
    mount();
    void api!.run({ title: 'Approve Target Store?', confirmLabel: 'Approve store', submit: vi.fn() });
    const dialog = await screen.findByRole('dialog', { name: 'Approve Target Store?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const box = within(dialog).getByRole('textbox', { name: 'Reason' });
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('a short reason is refused beside the field, with the server rule, and nothing is sent', async () => {
    const user = mount();
    const submit = vi.fn();
    void api!.run({ title: 'Suspend it?', confirmLabel: 'Suspend store', submit });
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox', { name: 'Reason' });
    await user.type(box, 'too short');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    expect(within(dialog).getByText(/at least 12 characters/)).toBeTruthy();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(box);
    expect(submit).not.toHaveBeenCalled();
    expect(within(dialog).getByText('9/500')).toBeTruthy();
  });

  it('a template phrase and an emoji are refused before sending', async () => {
    const user = mount();
    const submit = vi.fn();
    void api!.run({ title: 'Suspend it?', confirmLabel: 'Suspend store', submit });
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox', { name: 'Reason' });
    await user.type(box, 'Suspended by admin.');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    expect(within(dialog).getByText(/default text, not a reason/)).toBeTruthy();
    await user.clear(box);
    await user.type(box, 'Owner confirmed by phone 👍 today');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    expect(within(dialog).getByText(/emoji/)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('amount (GYD) and reference fields are checked, then handed over as a number and an upper-case reference', async () => {
    const user = mount();
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const done = api!.run({
      title: 'Record the refund?', confirmLabel: 'Record refund', submit, success: () => 'Recorded.',
      fields: [{ kind: 'amount', name: 'amount', label: 'Amount handed back (GYD)' }, { kind: 'reference', name: 'reference', label: 'Receipt reference' }],
    });
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByRole('textbox', { name: 'Amount handed back (GYD)' });
    const reference = within(dialog).getByRole('textbox', { name: 'Receipt reference' });
    expect(document.activeElement).toBe(amount);
    await user.type(amount, 'four thousand');
    await user.type(reference, 'r1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    expect(within(dialog).getByText(/not an amount/)).toBeTruthy();
    expect(within(dialog).getByText(/does not look like a reference/)).toBeTruthy();
    expect(document.activeElement).toBe(amount);
    expect(submit).not.toHaveBeenCalled();

    await user.clear(amount);
    await user.type(amount, 'G$4,500');
    await user.clear(reference);
    await user.type(reference, 'rcpt-2026/001');
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith({ reason: REASON, values: { amount: 4500, reference: 'RCPT-2026/001' } });
    expect(await done).toEqual({ tone: 'success', title: 'Recorded.' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('[MC-PR1] <ReasonDialog> runs the action and keeps the refusal in the panel', () => {
  it('a refusal stays inside the panel with the typed reason; a retry that works closes it', async () => {
    const user = mount();
    const submit = vi.fn()
      .mockRejectedValueOnce(serverError(409, 'CHECKLIST_INCOMPLETE', "Target Store's required documents are not all approved."))
      .mockResolvedValueOnce({ ok: true });
    const done = api!.run({ title: 'Approve Target Store?', confirmLabel: 'Approve store', submit, context: { applicantId: 'owner-1' }, success: () => 'Target Store is live.' });
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox', { name: 'Reason' });
    await user.type(box, REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve store' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Approve the required documents in Verification first');
    expect(within(alert).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=owner-1');
    expect((box as HTMLTextAreaElement).value).toBe(REASON);

    await user.click(within(dialog).getByRole('button', { name: 'Approve store' }));
    expect(await done).toEqual({ tone: 'success', title: 'Target Store is live.' });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('a 202 APPROVAL_REQUIRED closes the panel as "sent for a second admin", with the approval id', async () => {
    const user = mount();
    const submit = vi.fn().mockRejectedValue(serverError(202, 'APPROVAL_REQUIRED', 'A second admin must approve this before it happens. It is in the approvals queue.', { approvalId: 'apr_9' }));
    const done = api!.run({ title: 'Waive the fee?', confirmLabel: 'Waive', submit });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Waive' }));
    const outcome = await done;
    expect(outcome).toMatchObject({ tone: 'queued', title: "Sent for a second admin's approval", approvalId: 'apr_9', link: { href: '/approvals' } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc cancels (resolves null, nothing runs); after a refusal, closing hands the refusal back to the page', async () => {
    const user = mount();
    const submit = vi.fn().mockRejectedValue(serverError(403, 'FORBIDDEN', 'This admin action requires the vendor.suspend capability'));
    let done = api!.run({ title: 'Suspend it?', confirmLabel: 'Suspend store', submit });
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(await done).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    done = api!.run({ title: 'Suspend it?', confirmLabel: 'Suspend store', submit });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    expect(await done).toMatchObject({ tone: 'refused', code: 'FORBIDDEN', status: 403 });
  });

  it('while sending, Esc does nothing and the controls are locked', async () => {
    const user = mount();
    let release: (_v: unknown) => void = () => {};
    const submit = vi.fn(() => new Promise((r) => { release = r; }));
    const done = api!.run({ title: 'Suspend it?', confirmLabel: 'Suspend store', submit, success: () => 'Suspended.' });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    expect((within(dialog).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    release({});
    expect(await done).toEqual({ tone: 'success', title: 'Suspended.' });
  });

  it('a double click submits an order-review decision only once', async () => {
    const user = mount();
    let release: (_v: unknown) => void = () => {};
    const submit = vi.fn(() => new Promise((r) => { release = r; }));
    const done = api!.run({ title: 'Decide that the customer paid?', confirmLabel: 'Customer paid', submit, success: () => 'Sent.' });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    const confirm = within(dialog).getByRole('button', { name: 'Customer paid' });
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    release({});
    expect(await done).toEqual({ tone: 'success', title: 'Sent.' });
  });

  it('Tab stays inside the panel', async () => {
    const user = mount();
    void api!.run({ title: 'Feature it?', confirmLabel: 'Feature store', reason: false, submit: vi.fn() });
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(within(dialog).queryByRole('textbox')).toBeNull(); // a C2 confirmation asks no reason
  });

  it('useAskReason is the drop-in for askReason: same argument, a Promise of the reason or null', async () => {
    const user = mount();
    const answer = ask!({ action: 'ban this account', subject: 'a test user' });
    const dialog = await screen.findByRole('dialog', { name: 'Why are you about to ban this account for a test user?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), `  ${REASON}  `);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await answer).toBe(REASON);

    const cancelled = ask!({ action: 'ban this account' });
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(await cancelled).toBeNull();
  });

  it('without the provider it fails loudly — a panel that never opens would be silent again', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/ReasonDialogProvider/);
    spy.mockRestore();
  });
});
