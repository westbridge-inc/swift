/**
 * [CARS-DELIVER · owner 8 Oct + 25 Oct 2026] "Deliveries too": a taxi driver's car can also take store
 * deliveries. It sits behind the server's CAR_DELIVERIES switch, which stays OFF until counsel verifies that
 * a hire car may carry goods. The server answers GET /driver/deliveries with
 * { available, enabled, reason, vehicle }; this module turns that answer into what the account card shows:
 * NOTHING unless the server says "Deliveries too" can be set up now, or is set up already (an older server,
 * a failed read, or the switch off with nothing set up all mean no card).
 *
 * One person takes taxi rides OR deliveries at a time: the deliveries run on the account's delivery profile,
 * and the work mode switches between the two (the server's switch-role; it refuses while a job is live).
 */
export type WorkKind = 'DRIVER' | 'RIDER';

/** [PR4] "Taxi rides and deliveries": the taxi driver's switch between taxi rides only and both at once. */
export type BothToggle = { on: boolean; label: string; line: string };

export type DeliveriesTooView =
  | { show: false }
  | { show: true; state: 'offer'; title: string; body: string; action: string }
  | { show: true; state: 'ready'; title: string; body: string; action: string; target: WorkKind; both: BothToggle | null }
  | { show: true; state: 'paused'; title: string; body: string };

type Answer = { available?: unknown; enabled?: unknown; reason?: unknown; takesDeliveries?: unknown; vehicle?: { label?: unknown } | null } | null | undefined;

/** The work mode a switch from `kind` goes to, and the words on its button. */
export function switchTarget(kind: WorkKind): { target: WorkKind; label: string } {
  return kind === 'RIDER'
    ? { target: 'DRIVER', label: 'Switch to taxi rides' }
    : { target: 'RIDER', label: 'Switch to deliveries' };
}

export function deliveriesTooView(answer: unknown, kind: WorkKind | null): DeliveriesTooView {
  const a = (answer && typeof answer === 'object' ? answer : null) as Answer;
  if (!a || !kind) return { show: false };
  const enabled = a.enabled === true;
  const available = a.available === true;
  const vehicle = typeof a.vehicle?.label === 'string' && a.vehicle.label.trim()
    ? a.vehicle.label.trim().toLowerCase()
    : 'car';
  if (enabled && a.reason === 'SWITCH_OFF') {
    return {
      show: true, state: 'paused', title: 'Deliveries too',
      body: 'Deliveries by taxi car are paused on Swift for now. Taxi rides work as usual.',
    };
  }
  if (enabled) {
    const next = switchTarget(kind);
    // [PR4] In taxi mode, while the switch is on (available), the driver may take both at once. [REVIEW-F #2139 S4-3]
    // Only from a server that knows the mode (takesDeliveries is a boolean): a #2128-only server has no mode route.
    const bothOn = a.takesDeliveries === true;
    const both: BothToggle | null = kind === 'DRIVER' && available && serverKnowsTaxiAndDeliveries(a)
      ? bothOn
        ? { on: true, label: 'Back to taxi rides only', line: 'Taxi rides and deliveries is on: when you are online with no ride, store delivery offers come too. After a delivery you go back to taxi rides and deliveries.' }
        : { on: false, label: 'Turn on taxi rides and deliveries', line: 'Turn on taxi rides and deliveries to also get store delivery offers when you are online with no ride — still one job at a time.' }
      : null;
    return {
      show: true, state: 'ready', title: 'Deliveries too',
      body: `Your ${vehicle} can take store deliveries as well as taxi rides — one at a time. Switch here or on your home screen when you go offline.`,
      action: next.label, target: next.target, both,
    };
  }
  if (available && kind === 'DRIVER') {
    return {
      show: true, state: 'offer', title: 'Take deliveries too',
      body: `Use your ${vehicle} for store deliveries as well as taxi rides. Adding deliveries does not change your weekly fee, and you keep 100%.`,
      action: 'Add deliveries',
    };
  }
  return { show: false };
}

/**
 * [PR4 · REVIEW-F #2139 S2-2 · COORD 27 Oct] What this app declares at taxi GO: it can show a delivery card in taxi
 * mode (its pay, the cash box, "Accept delivery") and answer it on the delivery routes. The server offers a delivery
 * from taxi work only to a taxi GO that declared it; an older app, which would show a delivery as a ride, never does.
 */
export const DELIVERY_CARDS_CAPABILITY = 'CAR_DELIVERY_CARDS_V1';

/** A server that knows "taxi + deliveries": its GET /driver/deliveries answer carries takesDeliveries (true or false). */
export function serverKnowsTaxiAndDeliveries(answer: unknown): boolean {
  return !!answer && typeof answer === 'object' && typeof (answer as { takesDeliveries?: unknown }).takesDeliveries === 'boolean';
}

/**
 * The home screen's work-mode link: only for an account that holds both a taxi and a delivery profile, and
 * only while it is offline with no job (going offline first keeps the switch from dropping a live shift).
 */
export function workModeLink(opts: { dual: boolean; kind: WorkKind | null; online: boolean; hasActiveJob: boolean }):
  | { show: false }
  | { show: true; target: WorkKind; label: string } {
  if (!opts.dual || !opts.kind || opts.online || opts.hasActiveJob) return { show: false };
  return { show: true, ...switchTarget(opts.kind) };
}

/**
 * [PR4] Which kind of job an offer card is, from the offer itself (the server names it: orderType). A phone on
 * "taxi rides and deliveries" gets both kinds while in taxi mode; a card without the field (an older server) is
 * the app's current kind, as before.
 */
export function offerKindOf(offer: { orderType?: unknown } | null | undefined, fallback: WorkKind): WorkKind {
  const type = offer?.orderType;
  if (typeof type !== 'string' || !type) return fallback;
  return type === 'TAXI' ? 'DRIVER' : 'RIDER';
}
