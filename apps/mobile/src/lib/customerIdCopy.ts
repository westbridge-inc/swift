/**
 * [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] What the app may say about a customer's ID.
 *
 * A customer's ID now goes ON FILE the moment it is uploaded (no admin approval) unless the
 * server's automatic checks hold it for a person. "On file" means a picture of an ID is stored —
 * nobody read and confirmed it — so the app never says "verified" for it. Only an ID a person
 * approved is "checked". The server says which (`idCheck`); an older server that does not send it
 * is read from the submission's status, and an unknown answer claims nothing.
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
      return { title: 'Your ID is on file', body: 'Bigger orders are unlocked now. Taxi rides also need your profile photo, so your driver knows who to pick up.' };
    case 'NOT_ACCEPTED':
      return { title: 'We couldn’t accept this ID', body: 'Check that the photo shows your whole ID clearly, then try again — or contact us from Help.' };
    case 'WAITING':
      return { title: 'A person will check your ID', body: 'Someone on our team looks at it before taxi rides and bigger orders unlock. We’ll let you know.' };
    default:
      return { title: 'ID sent', body: 'We’ll let you know when taxi rides and bigger orders are unlocked.' };
  }
}

/** The Profile row's line under "Your ID". */
export function profileIdRowSub(check: unknown): string {
  switch (check) {
    // Taxi rides also need the profile photo, so the short line claims only what the ID unlocks.
    case 'ON_FILE': return 'On file — bigger orders unlocked';
    case 'CHECKED': return 'Checked by our team';
    case 'WAITING': return 'A person is checking it';
    case 'NOT_ACCEPTED': return 'Not accepted — add it again';
    default: return 'Needed for bigger orders and taxi rides';
  }
}
