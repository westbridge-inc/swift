// ---------------------------------------------------------------------------
// [AF-MOB-006] CUSTODY RECOVERY — the client's half, pure.
//
// After pickup, a delivery that goes wrong is an owned case on the server: a
// hold, a return, or a relay to another rider. The server decides every state
// and writes every sentence; this file only reads what it sent, defensively,
// so a screen never invents a state or a promise. The rider's report reasons
// mirror the API's RIDER_INCIDENT_REASONS (custody-case.ts) — the test reads
// that source as text so the two lists cannot drift.
// ---------------------------------------------------------------------------

/** What a rider may report after pickup, with the words they see. */
export const RIDER_PROBLEM_REASONS = [
  { code: 'VEHICLE_BREAKDOWN', label: 'My vehicle broke down' },
  { code: 'CRASH', label: 'I was in a crash' },
  { code: 'MEDICAL', label: 'I am unwell or injured' },
  { code: 'UNSAFE_RECIPIENT', label: 'The drop-off is not safe' },
  { code: 'RECIPIENT_ABSENT', label: 'Nobody is there to receive it' },
  { code: 'INACCESSIBLE_PROPERTY', label: 'I cannot get to the address' },
  { code: 'DAMAGED_OR_PROHIBITED', label: 'The goods are damaged or not allowed' },
  { code: 'WRONG_PACKAGE', label: 'I have the wrong order' },
  { code: 'POLICE_OR_ROAD_CLOSURE', label: 'Police stop or road closed' },
  { code: 'DEVICE_FAILURE', label: 'My phone is failing' },
  { code: 'OTHER', label: 'Something else' },
] as const;

export type RiderProblemReason = (typeof RIDER_PROBLEM_REASONS)[number]['code'];

/** The customer's and the store's view of a case, exactly as the order read sends it. */
export interface PartyCaseView {
  caseId: string;
  state: string;
  open: boolean;
  ownedBySupport: boolean;
  headline: string;
  body: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Read `custodyRecovery` off an order payload. Anything malformed is no card,
 *  never a guessed one. */
export function parsePartyCaseView(raw: unknown): PartyCaseView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const caseId = str(r['caseId']);
  const state = str(r['state']);
  const headline = str(r['headline']);
  const body = str(r['body']);
  if (!caseId || !state || !headline || !body) return null;
  return { caseId, state, open: r['open'] === true, ownedBySupport: r['ownedBySupport'] === true, headline, body };
}

/** The store's one action: confirm the goods came back. Only while a return is
 *  under way on a store order (a courier parcel goes back to its sender). */
export function storeCanConfirmReturn(view: PartyCaseView | null, orderStatus: string, orderType: string | null | undefined): boolean {
  return !!view && view.state === 'RETURN_REQUIRED' && String(orderStatus).toUpperCase() === 'RETURNING' && orderType !== 'COURIER';
}

/** The holder's view of the case on their live job. */
export interface HolderCaseView {
  caseId: string;
  state: string;
  open: boolean;
  version: number;
  ownedBySupport: boolean;
  youHoldTheGoods: boolean;
  transferCode: string | null;
  /** When the handoff code stops working (the handoff deadline), or null. */
  transferCodeExpiresAt: string | null;
  /** The handoff is pending but its code has expired: show that, never the digits. */
  codeExpired: boolean;
  floatToCollect: number;
  relayFirstName: string | null;
  instruction: string;
}

/** `now` is injectable for tests; a screen passes nothing. A code past its
 *  expiry on this phone is dropped between polls too, so the holder never
 *  shows a code the server would refuse. */
export function parseHolderCaseView(raw: unknown, now: number = Date.now()): HolderCaseView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const caseId = str(r['caseId']);
  const state = str(r['state']);
  const instruction = str(r['instruction']);
  if (!caseId || !state || !instruction) return null;
  const expiresAt = str(r['transferCodeExpiresAt']);
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const codeExpired = r['codeExpired'] === true || (Number.isFinite(expiresMs) && expiresMs <= now);
  const code = codeExpired ? null : str(r['transferCode']);
  const relay = r['relay'] && typeof r['relay'] === 'object' ? (r['relay'] as Record<string, unknown>) : null;
  return {
    caseId,
    state,
    open: r['open'] === true,
    version: Number.isInteger(r['version']) ? (r['version'] as number) : 0,
    ownedBySupport: r['ownedBySupport'] === true,
    youHoldTheGoods: r['youHoldTheGoods'] === true,
    transferCode: code && /^\d{6}$/.test(code) ? code : null,
    transferCodeExpiresAt: expiresAt,
    codeExpired,
    floatToCollect: !codeExpired && Number.isFinite(Number(r['floatToCollect'])) ? Math.max(0, Number(r['floatToCollect'])) : 0,
    relayFirstName: relay ? str(relay['firstName']) : null,
    instruction,
  };
}

/** A relay rider's pending handoff. */
export interface RelayTask {
  caseId: string;
  version: number;
  orderNumber: string;
  holderFirstName: string | null;
  holderLat: number | null;
  holderLng: number | null;
  floatToBring: number;
  instruction: string;
}

export function parseRelayTasks(raw: unknown): RelayTask[] {
  if (!Array.isArray(raw)) return [];
  const out: RelayTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const caseId = str(r['caseId']);
    const instruction = str(r['instruction']);
    if (!caseId || !instruction) continue;
    const holder = r['holder'] && typeof r['holder'] === 'object' ? (r['holder'] as Record<string, unknown>) : null;
    const lat = holder && typeof holder['lat'] === 'number' ? (holder['lat'] as number) : null;
    const lng = holder && typeof holder['lng'] === 'number' ? (holder['lng'] as number) : null;
    out.push({
      caseId,
      version: Number.isInteger(r['version']) ? (r['version'] as number) : 0,
      orderNumber: str(r['orderNumber']) ?? '',
      holderFirstName: holder ? str(holder['firstName']) : null,
      holderLat: lat,
      holderLng: lng,
      floatToBring: Number.isFinite(Number(r['floatToBring'])) ? Math.max(0, Number(r['floatToBring'])) : 0,
      instruction,
    });
  }
  return out;
}

/** A six-digit handoff code, digits only. */
export function isHandoffCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Show a party's case card? Open cases, returns and handoffs say something the
 *  order screen does not; a resolved DELIVERED or CLOSED case only repeats it. */
export function partyCaseWorthShowing(view: PartyCaseView | null): view is PartyCaseView {
  return !!view && (view.open || view.state === 'RETURNED' || view.state === 'TRANSFERRED');
}

/** What the relay rider's screen does with a refused handoff. */
export interface RelayErrorAction {
  /** Mint a new Idempotency-Key for the next try. Never after a lost answer or
   *  an in-flight duplicate: those must REPLAY, or a second attempt is burned. */
  rotateKey: boolean;
  closeDialog: boolean;
  refresh: boolean;
  /** Empty the code field: a new attempt starts blank, so a reflex second tap
   *  on "Confirm" cannot resend the refused code and burn a second attempt. */
  clearCode: boolean;
  message: string;
}

const GONE = 'This handoff was called off or given to another rider.';
const TERMINAL = new Set(['TRANSFER_NOT_PENDING', 'MAX_ATTEMPTS', 'TRANSFER_CODE_EXPIRED', 'RECOVERY_STALE']);

export function relayErrorAction(error: unknown): RelayErrorAction {
  const res = (error as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } } })?.response;
  if (!res) {
    return { rotateKey: false, closeDialog: false, refresh: false, clearCode: false, message: "Couldn't reach Swift. Try again — your last try is kept, not counted twice." };
  }
  const code = res.data?.error?.code ?? '';
  const message = res.data?.error?.message ?? "Couldn't confirm the handoff — try again.";
  if (code === 'DUPLICATE_REQUEST') {
    return { rotateKey: false, closeDialog: false, refresh: false, clearCode: false, message: 'Still confirming your last try — wait a moment, then try again.' };
  }
  if (res.status === 404) return { rotateKey: true, closeDialog: true, refresh: true, clearCode: true, message: GONE };
  if (TERMINAL.has(code)) return { rotateKey: true, closeDialog: true, refresh: true, clearCode: true, message };
  return { rotateKey: true, closeDialog: false, refresh: true, clearCode: true, message };
}

/** A failed decline: a gone handoff reads as plain words; refresh either way. */
export function declineErrorMessage(error: unknown): string {
  const res = (error as { response?: { status?: number; data?: { error?: { message?: string } } } })?.response;
  if (!res) return "Couldn't reach Swift — try again.";
  if (res.status === 404) return GONE;
  return res.data?.error?.message ?? "Couldn't decline — try again.";
}
