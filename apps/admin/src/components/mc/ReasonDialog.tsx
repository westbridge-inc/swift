'use client';

import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from '@/components/Modal';
import { ActionResult } from './ActionResult';
import { outcomeOf, succeeded, type Outcome, type OutcomeContext } from '@/lib/outcome';
import { REASON_MAX, REASON_MIN, checkReason, checkReference, normaliseReason, parseAmountGyd, type FieldCheck } from '@/lib/reason-rules';
import type { ReasonPrompt } from '@/lib/ask-reason';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] THE REASON PANEL — in the page, never a browser prompt.
//
// Owner ruling (6 Oct): no browser prompts. Reasons, amounts and references
// were typed into window.prompt / confirm / alert boxes, and a refusal from
// the server arrived after the box had gone, so the typed reason was lost and
// the refusal was usually never shown at all.
//
// This panel asks for the reason (12–500 characters, the server's rule) and
// any typed fields (an amount in GYD, a reference), checks them before
// sending, RUNS the action, and shows the server's refusal inside the panel
// with the typed reason still there to correct or retry. A 202 "queued for a
// second admin" closes it as the success-class answer it is.
//
// Use it through one of three hooks (mount <ReasonDialogProvider> once):
//   const dialog = useActionDialog();
//   const outcome = await dialog.run({ title, confirmLabel, submit, success, context });
//       → the panel runs `submit`; resolves the success/queued Outcome, the last
//         refusal if the operator closed it after one, or null if cancelled.
//   const answer = await dialog.askWith({ title, confirmLabel, fields });
//       → collects { reason, values } only (the caller sends it).
//   const ask = useAskReason();  const reason = await ask({ action, subject });
//       → the drop-in for lib/ask-reason `askReason` (same argument, a Promise of
//         the same string | null). Migrating a page is mechanical:
//           `const reason = askReason(p); if (reason) m.mutate(reason);`
//         becomes
//           `const reason = await ask(p); if (reason) m.mutate(reason);`
//         Prefer `run` where the refusal should stay in the panel.
// ---------------------------------------------------------------------------

export type ReasonField =
  | { kind: 'amount'; name: string; label: string; hint?: string; /** The route takes cents (default: whole GYD). */ cents?: boolean }
  | { kind: 'reference'; name: string; label: string; hint?: string };

export interface ReasonAnswer {
  /** The reason as it is sent: trimmed, smart punctuation made plain. Empty when none was asked. */
  reason: string;
  /** Typed fields, checked: amounts as numbers, references upper-cased. */
  values: Record<string, string | number>;
}

export interface ActionDialogRequest<T = unknown> {
  /** The question, naming the subject: "Approve Target Store?". */
  title: string;
  /** What will happen, in plain words. */
  body?: ReactNode;
  /** The button that does it: "Approve store". */
  confirmLabel: string;
  /** Ask for a reason (the default) with optional wording; `false` makes this a plain in-page confirmation. */
  reason?: false | { label?: string; hint?: string };
  fields?: ReasonField[];
  /** Lets a refusal link to the right place (the Review Center for this owner). */
  context?: OutcomeContext;
  /** Runs the action; throws on a refusal, as apiFetch does. */
  submit?: (_answer: ReasonAnswer) => Promise<T>;
  /** The words for success ("Target Store is live."). */
  success?: (_result: T, _answer: ReasonAnswer) => Outcome | string;
}

type Settlement = { kind: 'done'; answer: ReasonAnswer; outcome: Outcome | null } | { kind: 'cancelled'; lastOutcome: Outcome | null };

interface ActiveDialog {
  id: number;
  request: ActionDialogRequest<unknown>;
  resolve: (_settlement: Settlement) => void;
}

export interface ActionDialogApi {
  run<T>(_request: ActionDialogRequest<T> & { submit: (_answer: ReasonAnswer) => Promise<T> }): Promise<Outcome | null>;
  askWith(_request: Omit<ActionDialogRequest<never>, 'submit' | 'success'>): Promise<ReasonAnswer | null>;
  ask(_prompt: ReasonPrompt): Promise<string | null>;
}

const DialogContext = createContext<{ open: (_request: ActionDialogRequest<unknown>) => Promise<Settlement> } | null>(null);

/** Mount once, above every page that asks for a reason. One panel at a time. */
export function ReasonDialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const current = useRef<ActiveDialog | null>(null);
  const seq = useRef(0);

  const open = useCallback((request: ActionDialogRequest<unknown>) => new Promise<Settlement>((resolve) => {
    // A second ask while one is open is refused, not stacked: nothing runs.
    if (current.current) { resolve({ kind: 'cancelled', lastOutcome: null }); return; }
    const next = { id: ++seq.current, request, resolve };
    current.current = next;
    setActive(next);
  }), []);

  const settle = useCallback((settlement: Settlement) => {
    const done = current.current;
    current.current = null;
    setActive(null);
    done?.resolve(settlement);
  }, []);

  const value = useMemo(() => ({ open }), [open]);
  return (
    <DialogContext.Provider value={value}>
      {children}
      {active ? <ActionDialog key={active.id} request={active.request} onSettle={settle} /> : null}
    </DialogContext.Provider>
  );
}

export function useActionDialog(): ActionDialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useActionDialog needs <ReasonDialogProvider> above it (app/providers.tsx mounts it).');
  return useMemo<ActionDialogApi>(() => ({
    run: async (request) => {
      const settled = await ctx.open(request as ActionDialogRequest<unknown>);
      return settled.kind === 'done' ? settled.outcome : settled.lastOutcome;
    },
    askWith: async (request) => {
      const settled = await ctx.open(request);
      return settled.kind === 'done' ? settled.answer : null;
    },
    ask: async ({ action, subject }) => {
      const settled = await ctx.open({
        title: `Why are you about to ${action}${subject ? ` for ${subject}` : ''}?`,
        body: <p>This goes on the permanent record and is what an appeal or an audit will be answered with.</p>,
        confirmLabel: 'Continue',
      });
      return settled.kind === 'done' ? settled.answer.reason : null;
    },
  }), [ctx]);
}

/** The drop-in for `askReason`: same argument, a Promise of the same `string | null`. */
export function useAskReason(): (_prompt: ReasonPrompt) => Promise<string | null> {
  const dialog = useActionDialog();
  return dialog.ask;
}

function checkField(field: ReasonField, raw: string): FieldCheck<string | number> {
  return field.kind === 'amount' ? parseAmountGyd(raw, { cents: field.cents }) : checkReference(raw);
}

function ActionDialog({ request, onSettle }: { request: ActionDialogRequest<unknown>; onSettle: (_s: Settlement) => void }) {
  const uid = useId();
  const fields = request.fields ?? [];
  const asksReason = request.reason !== false;
  const reasonWords = request.reason === false ? undefined : request.reason;
  const [reasonText, setReasonText] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Outcome | null>(null);

  const reasonCheck = asksReason ? checkReason(reasonText) : null;
  const fieldChecks = fields.map((f) => checkField(f, values[f.name] ?? ''));
  const typed = normaliseReason(reasonText).length;

  const cancel = () => { if (!busy) onSettle({ kind: 'cancelled', lastOutcome: refusal }); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setShown(Object.fromEntries([['reason', true], ...fields.map((f) => [f.name, true])]));
    const firstBad = fields.findIndex((_, i) => !fieldChecks[i]!.ok);
    if (firstBad >= 0) { document.getElementById(`${uid}-${fields[firstBad]!.name}`)?.focus(); return; }
    if (reasonCheck && !reasonCheck.ok) { document.getElementById(`${uid}-reason`)?.focus(); return; }
    const answer: ReasonAnswer = {
      reason: reasonCheck?.ok ? reasonCheck.reason : '',
      values: Object.fromEntries(fields.map((f, i) => [f.name, (fieldChecks[i] as { ok: true; value: string | number }).value])),
    };
    if (!request.submit) { onSettle({ kind: 'done', answer, outcome: null }); return; }
    setBusy(true);
    setRefusal(null);
    try {
      const result = await request.submit(answer);
      const words = request.success ? request.success(result, answer) : 'Done.';
      onSettle({ kind: 'done', answer, outcome: typeof words === 'string' ? succeeded(words) : words });
    } catch (error) {
      const outcome = outcomeOf(error, { kind: 'write', ...request.context });
      // A queued approval is the success-class answer for a money action: close.
      if (outcome.tone === 'queued') { onSettle({ kind: 'done', answer, outcome }); return; }
      setRefusal(outcome);
      setBusy(false);
    }
  };

  return (
    <Modal title={request.title} onClose={cancel} busy={busy} className="mc-dialog">
      <form onSubmit={submit} noValidate aria-busy={busy || undefined}>
        <h2>{request.title}</h2>
        {request.body ? <div className="mc-dialog-body">{request.body}</div> : null}

        {fields.map((field, i) => {
          const id = `${uid}-${field.name}`;
          const check = fieldChecks[i]!;
          const showError = shown[field.name] && !check.ok;
          return (
            <div key={field.name}>
              <label htmlFor={id}>{field.label}</label>
              <input
                id={id}
                value={values[field.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                onBlur={() => setShown((s) => ({ ...s, [field.name]: true }))}
                inputMode={field.kind === 'amount' ? 'decimal' : 'text'}
                autoCapitalize={field.kind === 'reference' ? 'characters' : undefined}
                autoComplete="off"
                disabled={busy}
                aria-invalid={showError || undefined}
                aria-describedby={`${id}-help${showError ? ` ${id}-error` : ''}`}
              />
              <p id={`${id}-help`} className="mc-field-help">
                <span>{field.hint ?? (field.kind === 'amount' ? (field.cents ? 'In GYD, e.g. 4500 or 4500.50' : 'In whole GYD, e.g. 4500') : 'As written on the receipt or transfer')}</span>
              </p>
              {showError && !check.ok ? <p id={`${id}-error`} className="mc-field-error">{check.message}</p> : null}
            </div>
          );
        })}

        {asksReason ? (() => {
          const id = `${uid}-reason`;
          const showError = shown['reason'] && reasonCheck && !reasonCheck.ok;
          return (
            <div>
              <label htmlFor={id}>{reasonWords?.label ?? 'Reason'}</label>
              <textarea
                id={id}
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                onBlur={() => { if (reasonText.trim()) setShown((s) => ({ ...s, reason: true })); }}
                maxLength={REASON_MAX + 200}
                disabled={busy}
                aria-invalid={showError || undefined}
                aria-describedby={`${id}-help${showError ? ` ${id}-error` : ''}`}
              />
              <p id={`${id}-help`} className="mc-field-help">
                <span>{reasonWords?.hint ?? 'Kept on the permanent record.'} At least {REASON_MIN} characters.</span>
                <span aria-hidden="true" className="mc-numbers">{typed}/{REASON_MAX}</span>
              </p>
              {showError && reasonCheck && !reasonCheck.ok ? <p id={`${id}-error`} className="mc-field-error">{reasonCheck.message}</p> : null}
            </div>
          );
        })() : null}

        <ActionResult outcome={refusal} />

        <div className="mc-dialog-actions">
          <button type="button" className="mc-btn" onClick={cancel} disabled={busy}>
            {refusal ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
            {busy ? 'Sending…' : request.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
