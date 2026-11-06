// [OWNER 5 Nov 2026] Paying the weekly fee in person: its words. Kept out of the shared fee library so the web
// page's first load does not carry them (the web page loads them only when the server says the door accepts or a
// record waits; perf budget). Kept identical across the two independently built apps (census).
import { feeMoney } from './fee-status';

/** The other way to pay, shown only where the server's `inPerson.open` says the door accepts. */
export const PAY_IN_PERSON = 'You can also pay Swift directly, in person, by cash, cheque or bank transfer. A cheque counts once it clears. A payment counts once Swift records it, and your status here changes then. You get a receipt. Never give it to anyone else.';
export const PAY_IN_PERSON_ASK = 'Ask Swift to arrange it';
/** Said while a person's record of that payment waits. */
export function inPersonWaiting(amountGyd: number | null): string {
  return `Swift has your in-person payment${amountGyd === null ? '' : ` of ${feeMoney(amountGyd)}`} and is recording it. It counts once it is recorded, and your status here changes then. Do not pay again.`;
}
