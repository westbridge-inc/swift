import { adaptivePollInterval, slowNetworkPollInterval } from './adaptivePolling';

/** Every fallback poll cadence that adapts to the network, in one place.
 *
 * Socket-pushed (server emit sites in apps/api): chat:message to chat:<room>;
 * order:new / order:status_changed / order:pick_state to vendor:<id>. Those
 * may slow while the socket is connected.
 *
 * Not pushed: movers receive only dispatch:offer, the offer withdrawal and
 * notification on their user room, and no mover screen joins an order room,
 * so the board, active job, stacked legs and demand keep their cadence while
 * connected and back off only on a slow network. Same for the vendor profile. */
export const POLL = {
  chatMessages: () => adaptivePollInterval(4000, 15000),
  vendorOrders: () => adaptivePollInterval(12000, 30000),
  vendorOrder: () => adaptivePollInterval(15000, 30000),
  vendorProfile: () => slowNetworkPollInterval(20000, 30000),
  moverDemand: () => slowNetworkPollInterval(20_000, 30000),
  moverAvailable: () => slowNetworkPollInterval(10000, 30000),
  moverActive: () => slowNetworkPollInterval(12000, 30000),
  moverLegs: () => slowNetworkPollInterval(12000, 30000),
};
