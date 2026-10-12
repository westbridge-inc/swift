import { adaptivePollInterval, slowNetworkPollInterval } from './adaptivePolling';
import { vendorOrderFeedLive } from './vendorOrderFeed';

/** Every fallback poll cadence that adapts to the network, in one place.
 *
 * Socket-pushed (server emit sites in apps/api): chat:message to chat:<room>;
 * order:new / order:status_changed / order:prep_update / order:pick_state to
 * vendor:<id>. Chat may slow while the socket is connected; the vendor order
 * queries only while a store feed the server admits is bound
 * (bindVendorOrderFeed): a held store shows orders with no feed, and the
 * server joins only the store owner to vendor:<id>, so staff and managers
 * keep the full cadence.
 *
 * Not pushed: the mover active job, stacked legs and demand get no socket
 * event (movers receive only dispatch:offer, the offer withdrawal and
 * notification on their user room, and mover screens join no order room).
 * The job board is refreshed on offer events but not on other board changes.
 * So all four keep their cadence while connected and back off only on a slow
 * network. Same for the vendor profile. */
export const POLL = {
  chatMessages: () => adaptivePollInterval(4000, 15000),
  vendorOrders: () => (vendorOrderFeedLive() ? adaptivePollInterval : slowNetworkPollInterval)(12000, 30000),
  vendorOrder: () => (vendorOrderFeedLive() ? adaptivePollInterval : slowNetworkPollInterval)(15000, 30000),
  vendorProfile: () => slowNetworkPollInterval(20000, 30000),
  moverDemand: () => slowNetworkPollInterval(20_000, 30000),
  moverAvailable: () => slowNetworkPollInterval(10000, 30000),
  moverActive: () => slowNetworkPollInterval(12000, 30000),
  moverLegs: () => slowNetworkPollInterval(12000, 30000),
};
