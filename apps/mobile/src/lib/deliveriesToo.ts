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

export type DeliveriesTooView =
  | { show: false }
  | { show: true; state: 'offer'; title: string; body: string; action: string }
  | { show: true; state: 'ready'; title: string; body: string; action: string; target: WorkKind }
  | { show: true; state: 'paused'; title: string; body: string };

type Answer = { available?: unknown; enabled?: unknown; reason?: unknown; vehicle?: { label?: unknown } | null } | null | undefined;

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
    return {
      show: true, state: 'ready', title: 'Deliveries too',
      body: `Your ${vehicle} can take store deliveries as well as taxi rides — one at a time. Switch here or on your home screen when you go offline.`,
      action: next.label, target: next.target,
    };
  }
  if (available && kind === 'DRIVER') {
    return {
      show: true, state: 'offer', title: 'Take deliveries too',
      body: `Use your ${vehicle} for store deliveries as well as taxi rides. Your weekly fee stays the same, and you keep 100%.`,
      action: 'Add deliveries',
    };
  }
  return { show: false };
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
