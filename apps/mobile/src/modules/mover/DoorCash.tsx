/** @jsxImportSource react */
import React, { useState } from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { ChoiceChip, LabeledInput, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { toast } from '../../kit/toast';
import { moneyIn } from '../../lib/money';
import {
  CASH_STATEMENT_REFUSALS,
  DOOR_CODE_REFUSALS,
  doorCashDue,
  doorCashFields,
  doorCashRecordCopy,
  doorCashRecordFrom,
  needsReturnAnswer,
  parseCashEntry,
  type DoorCashFields,
  type DoorCashStatement,
} from '../../lib/doorCash';
import { AuthSessionBoundaryError } from '../../stores/authStore';
import { dk, withAlpha } from './surface';

// ---------------------------------------------------------------------------
// [L02 · row 56 · owner rulings 5 + 7 Oct] THE CASH DOOR OF A GOODS DELIVERY.
//
// The rider states what happened at the door, and the server (#1542) decides
// what it means and records it:
//   - "Record cash & hand over": the cash actually taken. In full = recorded
//     and the delivery completes. Over = refused. Short = refused with the
//     server's own words, which offer the two honest ways on.
//   - "Customer can't pay in full": NO hand-over; the order goes back to the
//     store. Partial cash is handed back first and the rider says whether it
//     was (if not, the amount is recorded as still held and operations follow
//     up). Swift moves, refunds and deducts nothing.
//   - "I already handed the order over": recorded short, held for review.
//
// Every statement is typed, reviewed, then confirmed: nothing is sent from a
// single tap. While it is sent the popup says so; afterwards the rider reads
// what the SERVER recorded (its figures, never this screen's arithmetic).
// ---------------------------------------------------------------------------

export type DoorCashSubmit = (
  fields: DoorCashFields & { pin?: string },
  handlers: { onSuccess: (res: unknown) => void; onError: (err: unknown) => void },
) => void;

type Sheet = 'none' | 'paid' | 'cannot-pay' | 'handed-over-short';
type Refusal = { code: string; message: string };

const NO_ANSWER =
  'No answer from Swift, so this may not be recorded yet. Check your signal and confirm again: Swift records a door outcome only once.';

function statementFor(sheet: Sheet, collected: number, cashReturned: boolean | null): DoorCashStatement | null {
  if (sheet === 'paid') return { kind: 'paid', collected };
  if (sheet === 'handed-over-short') return { kind: 'handed-over-short', collected };
  if (sheet === 'cannot-pay') return { kind: 'cannot-pay', collected, cashReturned };
  return null;
}

export function DoorCash({
  job,
  pin,
  busy,
  pending,
  submit,
  onDoorRefused,
  children,
}: {
  /** The live job, as the server sent it (the amount due and its currency come from here). */
  job: any;
  /** The door code typed on the screen: sent with the hand-over outcomes, never with "can't pay". */
  pin: string;
  /** Another action on the screen is running. */
  busy: boolean;
  /** This door's request is in flight. */
  pending: boolean;
  submit: DoorCashSubmit;
  /** The screen's answer to a door refusal (a wrong code, a stale door). */
  onDoorRefused: (err: unknown) => void;
  /** The door-code ceremony, drawn between the amount due and the actions. */
  children?: React.ReactNode;
}) {
  const [sheet, setSheet] = useState<Sheet>('none');
  // Where "Go back" returns to from the short hand-over popup.
  const [from, setFrom] = useState<Sheet>('none');
  const [reviewing, setReviewing] = useState(false);
  const [entry, setEntry] = useState('');
  const [cashReturned, setCashReturned] = useState<boolean | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const due = doorCashDue(job);
  const fmt = (n: number) => moneyIn(n, due?.currency ?? 'GYD');
  const collected = parseCashEntry(entry);
  const entryError = entry.trim() !== '' && collected === null ? 'Whole Guyana dollars only, like 2500.' : undefined;
  const statement = collected === null ? null : statementFor(sheet, collected, cashReturned);
  const ready = statement !== null && !needsReturnAnswer(statement);

  const open = (next: Sheet) => {
    setFrom(sheet);
    setSheet(next);
    setReviewing(next === 'handed-over-short');
    setRefusal(null);
  };
  const close = () => {
    if (pending) return; // the answer decides what the rider sees next
    setSheet('none');
    setReviewing(false);
    setRefusal(null);
  };

  const confirm = () => {
    if (!statement || !ready || pending) return;
    const fields = doorCashFields(statement);
    setRefusal(null);
    submit(
      // The door code proves a hand-over: it rides the 'paid' outcomes only.
      { ...fields, ...(fields.outcome === 'paid' && pin ? { pin } : {}) },
      {
        onSuccess: (res) => {
          const rec = doorCashRecordFrom(res);
          setSheet('none');
          setReviewing(false);
          setEntry('');
          setCashReturned(null);
          if (rec) {
            const words = doorCashRecordCopy(rec, fmt);
            (words.held ? toast.show : toast.success)(words.title, words.body);
          } else {
            toast.show('Recorded', 'Refresh to see the order’s current state.');
          }
        },
        onError: (err) => {
          if (err instanceof AuthSessionBoundaryError) {
            setSheet('none');
            return;
          }
          const response = (err as { response?: { data?: { error?: { code?: string; message?: string } } } })?.response;
          if (!response) {
            setRefusal({ code: 'NO_ANSWER', message: NO_ANSWER });
            return;
          }
          const code = response.data?.error?.code ?? 'UNKNOWN';
          const message = response.data?.error?.message ?? 'Swift could not record this. Try again or contact support.';
          if (DOOR_CODE_REFUSALS.has(code)) {
            // The code is fixed on the screen: close, and let the screen say why.
            setSheet('none');
            setReviewing(false);
            onDoorRefused(err);
            return;
          }
          if (CASH_STATEMENT_REFUSALS.has(code)) {
            // The server's words, with the rider's entry kept to correct.
            setReviewing(sheet === 'handed-over-short');
            setRefusal({ code, message });
            return;
          }
          onDoorRefused(err); // a stale door refreshes itself
          setRefusal({ code, message });
        },
      },
    );
  };

  const refusalBox = refusal ? (
    <View
      testID="door-cash-refusal"
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.error, 0.1), borderWidth: 1, borderColor: withAlpha(color.error, 0.35), padding: space.md, marginTop: space.md }}
    >
      <T variant="label" style={{ flex: 1 }}>{refusal.message}</T>
    </View>
  ) : null;

  const dueLine = (
    <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
      {due ? `Due for this order: ${fmt(due.amount)} (GYD).` : 'The amount due is not loaded — refresh before taking cash.'}
    </T>
  );

  const summaryRow = (label: string, value: string) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
      <T variant="body" tone="muted">{label}</T>
      <T variant="body" weight="bold">{value}</T>
    </View>
  );

  const amountField = (label: string, placeholder: string) => (
    <LabeledInput
      testID="door-cash-amount"
      label={label}
      accessibilityLabel={`${label}, in whole Guyana dollars`}
      value={entry}
      onChangeText={(t) => { setEntry(t); setRefusal(null); }}
      keyboardType="number-pad"
      placeholder={placeholder}
      editable={!pending}
      error={entryError}
      containerStyle={{ marginTop: space.lg, alignSelf: 'stretch' }}
    />
  );

  const pendingLine = pending ? (
    <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
      Recording with Swift — keep this screen open.
    </T>
  ) : null;

  return (
    <>
      <View
        testID="door-cash-due"
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: radius.lg, backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, padding: space.md, marginBottom: space.md }}
      >
        <T variant="label" style={{ color: dk.muted }}>Cash due at the door (GYD)</T>
        <T variant="title" weight="bold" style={{ color: dk.text }}>{due ? fmt(due.amount) : '—'}</T>
      </View>
      {children}
      <PillButton
        label="Record cash & hand over"
        testID="door-cash-paid"
        disabled={busy}
        onPress={() => open('paid')}
        style={{ minHeight: 56 }}
      />
      <PillButton
        label="Customer can't pay in full"
        testID="door-cash-cannot-pay"
        variant="soft"
        style={{ marginTop: space.sm }}
        disabled={busy}
        onPress={() => open('cannot-pay')}
      />

      {/* 1. The cash taken, then the hand-over. */}
      <PopupCard visible={sheet === 'paid'} onClose={close}>
        <PopupTitle center>{reviewing ? 'Record the cash and hand over?' : 'How much cash did you take?'}</PopupTitle>
        {!reviewing ? (
          <>
            {dueLine}
            <T variant="body" tone="muted" center style={{ marginTop: space.xs }}>
              Count it, then type exactly what you took.
            </T>
            {amountField('Cash taken (GYD)', 'Amount in GYD')}
            {refusalBox}
            {refusal?.code === 'CASH_SHORT_NO_HANDOVER' ? (
              <>
                <PillButton label="Customer can't pay in full" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => open('cannot-pay')} />
                <PillButton label="I already handed the order over" variant="outline" style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={() => open('handed-over-short')} />
              </>
            ) : (
              <PillButton label="Review" testID="door-cash-review" disabled={!ready} style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => { setRefusal(null); setReviewing(true); }} />
            )}
            <PillButton label="Go back" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={close} />
          </>
        ) : (
          <>
            {due ? summaryRow('Due', fmt(due.amount)) : null}
            {collected !== null ? summaryRow('You took', fmt(collected)) : null}
            <T variant="body" tone="muted" center style={{ marginTop: space.md }}>
              Swift checks it against the order and completes the delivery. Hand over only once it is recorded.
            </T>
            {refusalBox}
            {pendingLine}
            <PillButton label="Confirm — record & hand over" testID="door-cash-confirm" loading={pending} style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={confirm} />
            <PillButton label="Change amount" variant="soft" disabled={pending} style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={() => { setRefusal(null); setReviewing(false); }} />
          </>
        )}
      </PopupCard>

      {/* 2. The customer can't pay in full: no hand-over, back to the store. */}
      <PopupCard visible={sheet === 'cannot-pay'} onClose={close}>
        <PopupTitle center>{reviewing ? 'Send the order back to the store?' : "Customer can't pay in full?"}</PopupTitle>
        {!reviewing ? (
          <>
            <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
              Don't hand the order over: it goes back to the store.
            </T>
            {dueLine}
            {amountField('Cash the customer gave you (GYD)', '0 if none')}
            {collected !== null && collected > 0 ? (
              <>
                <T variant="label" weight="semibold" style={{ marginTop: space.md }}>
                  Give it back to the customer now. Did you?
                </T>
                <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                  <ChoiceChip full label="I gave it back" active={cashReturned === true} onPress={() => setCashReturned(true)} />
                  <ChoiceChip full label="I couldn't" active={cashReturned === false} onPress={() => setCashReturned(false)} />
                </View>
              </>
            ) : null}
            {refusalBox}
            <PillButton label="Review" testID="door-cash-review" disabled={!ready} style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => { setRefusal(null); setReviewing(true); }} />
            <PillButton
              label="I already handed the order over"
              variant="outline"
              disabled={collected === null}
              style={{ alignSelf: 'stretch', marginTop: space.sm }}
              onPress={() => open('handed-over-short')}
            />
            <PillButton label="Go back" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={close} />
          </>
        ) : (
          <>
            {due ? summaryRow('Due', fmt(due.amount)) : null}
            {collected !== null ? summaryRow('Customer gave you', fmt(collected)) : null}
            {collected !== null && collected > 0
              ? summaryRow('That cash', cashReturned ? 'Given back' : 'Still with you')
              : null}
            <T variant="body" tone="muted" center style={{ marginTop: space.md }}>
              {collected !== null && collected > 0 && cashReturned === false
                ? 'Swift records that you still hold it and operations follow up with you to return it. Keep the order: it goes back to the store.'
                : 'Keep the order: it goes back to the store.'}
            </T>
            {refusalBox}
            {pendingLine}
            <PillButton label="Confirm — don't hand over" testID="door-cash-confirm" loading={pending} style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={confirm} />
            <PillButton label="Change" variant="soft" disabled={pending} style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={() => { setRefusal(null); setReviewing(false); }} />
          </>
        )}
      </PopupCard>

      {/* 3. Already handed over for less than due: recorded short, held for review. */}
      <PopupCard visible={sheet === 'handed-over-short'} onClose={close}>
        <PopupTitle center>You already handed the order over?</PopupTitle>
        {due ? summaryRow('Due', fmt(due.amount)) : null}
        {collected !== null ? summaryRow('You took', fmt(collected)) : null}
        <T variant="body" tone="muted" center style={{ marginTop: space.md }}>
          Swift records the hand-over as short and holds it for operations to review. Under Swift's rule the difference is yours to bear; Swift deducts nothing from anyone.
        </T>
        {refusalBox}
        {pendingLine}
        <PillButton label="Confirm — record short hand-over" testID="door-cash-confirm" loading={pending} disabled={!ready} style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={confirm} />
        <PillButton label="Go back" variant="soft" disabled={pending} style={{ alignSelf: 'stretch', marginTop: space.sm }} onPress={() => { setSheet(from); setReviewing(false); setRefusal(null); }} />
      </PopupCard>
    </>
  );
}
