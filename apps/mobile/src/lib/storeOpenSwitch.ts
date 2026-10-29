// [PERF row 562] The "Store open" switch answers at the tap.
//
// It used to stay where it was (only dimmed) until the server answered AND the
// store had been read again: two round trips, about a third of a second on a
// good line and over a second on a slow one. Since #1949 the phone tells the
// server the state the store should END in (never "flip whatever you hold"),
// so showing that state early is safe and reversible: the switch moves in the
// same frame, stays locked until the server answers, then shows the server's
// own answer at once. If the server refuses or the line drops, the switch goes
// back to what the server last said, the refusal is shown in the server's
// words, and the store is read again.
//
// Money and dispatch never use this: paying, accepting or handing over an
// order, delivery mode. Those show progress at once and success only after the
// server confirms.

/** What the switch shows: the state just tapped while its request is out, otherwise the server's. */
export function shownStoreOpen(serverOpen: boolean, pending: boolean, tapped: unknown): boolean {
  return pending && typeof tapped === 'boolean' ? tapped : serverOpen;
}

/** The server's answer to a store switch: both flags as it now holds them. */
export type StoreSwitchAnswer = { isCurrentlyOpen?: unknown; acceptingOrders?: unknown } | null | undefined;

export function isConfirmedStoreSwitch(answer: StoreSwitchAnswer): answer is { isCurrentlyOpen: boolean; acceptingOrders: boolean } {
  return typeof answer?.isCurrentlyOpen === 'boolean' && typeof answer.acceptingOrders === 'boolean';
}

/** The profile read with the server's answer written into the store it was for.
 *  Anything it cannot place (no store id, no profile, a store not in it, an
 *  answer without both flags) comes back unchanged: the re-read settles it. */
export function withStoreSwitchAnswer<T>(profile: T, storeId: string | null | undefined, answer: StoreSwitchAnswer): T {
  if (!storeId || !isConfirmedStoreSwitch(answer)) return profile;
  const vendors = (profile as { vendors?: unknown } | null | undefined)?.vendors;
  if (!Array.isArray(vendors) || !vendors.some((v) => (v as { id?: unknown } | null)?.id === storeId)) return profile;
  return {
    ...(profile as object),
    vendors: vendors.map((v) => ((v as { id?: unknown } | null)?.id === storeId
      ? { ...(v as object), isCurrentlyOpen: answer.isCurrentlyOpen, acceptingOrders: answer.acceptingOrders }
      : v)),
  } as T;
}

/** [TAP-AUDIT] The profile read with some of one store's own fields as the server answered them (the "Deliver my own
 *  orders" and "Ask for the pickup code" switches answer with the saved store). Only boolean answers are written;
 *  anything it cannot place comes back unchanged and the re-read settles it. */
export function withStoreFields<T>(profile: T, storeId: string | null | undefined, answer: unknown, fields: readonly string[]): T {
  if (!storeId || !answer || typeof answer !== 'object') return profile;
  const picked = Object.fromEntries(fields.filter((f) => typeof (answer as Record<string, unknown>)[f] === 'boolean').map((f) => [f, (answer as Record<string, unknown>)[f]]));
  if (!Object.keys(picked).length) return profile;
  const vendors = (profile as { vendors?: unknown } | null | undefined)?.vendors;
  if (!Array.isArray(vendors) || !vendors.some((v) => (v as { id?: unknown } | null)?.id === storeId)) return profile;
  return { ...(profile as object), vendors: vendors.map((v) => ((v as { id?: unknown } | null)?.id === storeId ? { ...(v as object), ...picked } : v)) } as T;
}
