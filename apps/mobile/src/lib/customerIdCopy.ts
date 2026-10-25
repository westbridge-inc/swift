/**
 * [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] What the app may say about a customer's ID.
 *
 * A customer's ID now goes ON FILE the moment it is uploaded (no admin approval) unless the
 * server's automatic checks hold it for a person. "On file" means a picture of an ID is stored —
 * nobody read and confirmed it — so the app never says "verified" for it. Only an ID a person
 * approved is "checked". The server says which (`idCheck`); an older server that does not send it
 * is read from the submission's status, and an unknown answer claims nothing.
 *
 * [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE] Taxi rides and bigger orders no longer
 * need the ID, so no line here claims they unlock: the ID is optional, and it is kept with the
 * account as the Privacy Policy explains.
 */
export type CustomerIdCheck = 'NONE' | 'ON_FILE' | 'CHECKED' | 'WAITING' | 'NOT_ACCEPTED';

const KNOWN: ReadonlySet<string> = new Set(['NONE', 'ON_FILE', 'CHECKED', 'WAITING', 'NOT_ACCEPTED']);

/** The outcome of an ID upload: the server's `idCheck`, else derived from the document status. */
export function idCheckOf(result: { idCheck?: unknown; status?: unknown } | null | undefined): CustomerIdCheck | null {
  if (!result) return null;
  if (typeof result.idCheck === 'string' && KNOWN.has(result.idCheck)) return result.idCheck as CustomerIdCheck;
  if (result.status === 'APPROVED') return 'ON_FILE';
  if (result.status === 'PENDING') return 'WAITING';
  if (result.status === 'REJECTED') return 'NOT_ACCEPTED';
  return null;
}

/** The screen shown after the upload. */
export function submittedCopy(check: CustomerIdCheck | null): { title: string; body: string } {
  switch (check) {
    case 'ON_FILE':
    case 'CHECKED':
      // [Owner ruling 24 Oct 2026] Nothing unlocks: the ID is simply kept (the server's own notice says the same).
      return { title: 'Your ID is on file', body: 'Thanks — it is kept with your account, as the Privacy Policy explains.' };
    case 'NOT_ACCEPTED':
      return { title: 'We couldn’t accept this ID', body: 'Check that the photo shows your whole ID clearly, then try again — or contact us from Help.' };
    case 'WAITING':
      return { title: 'A person will check your ID', body: 'Someone on our team looks at it first. We’ll let you know.' };
    default:
      return { title: 'ID sent', body: 'We’ll let you know when it is on file.' };
  }
}

/** The Profile row's line under "Your ID". */
export function profileIdRowSub(check: unknown): string {
  switch (check) {
    case 'ON_FILE': return 'On file';
    case 'CHECKED': return 'Checked by our team';
    case 'WAITING': return 'A person is checking it';
    case 'NOT_ACCEPTED': return 'Not accepted — add it again';
    // NONE also reaches an account already above L1 with no customer ID on record. [24 Oct 2026] An ID
    // is optional: never say this account needs one.
    default: return 'Optional';
  }
}
