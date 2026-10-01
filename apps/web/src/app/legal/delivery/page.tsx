import { PolicyDocument, policyMetadata } from '@/components/policy-document';
import { site, launch } from '@/site.config';

/**
 * [Q36 item 7] The delivery policy, as Swift works today. Each rule is read
 * from the code:
 *  - every store sets its own delivery radius, and an address outside it is
 *    refused before the order is placed (order.service.ts, OUT_OF_RANGE);
 *  - the fee is a base fee plus a per-kilometre rate beyond the included
 *    distance, from the country's delivery-fee schedule (utils/markup.ts). The
 *    live figures can come from configuration, so this page quotes no number:
 *    the cart shows the exact fee before checkout;
 *  - times are estimates (dispatch/live-eta.ts drives no contractual timer);
 *  - a no-show needs the rider's arrival plus a 5-minute wait, and a strike
 *    needs evidence (cash/cash-rules.service.ts, order/cancel-policy.ts).
 * "No deliveries outside Guyana, no exports" is a business commitment
 * awaiting the owner's approval: which countries Swift serves is data.
 */

const UPDATED = '1 October 2026';

export const metadata = policyMetadata(
  'Delivery policy',
  `Where ${site.tradeName} delivers, how the delivery fee is set, delivery times, pickup, and what happens when a delivery cannot be completed.`,
  '/legal/delivery',
);

export default function DeliveryPage() {
  return (
    <PolicyDocument title="Delivery policy" updated={UPDATED}>
      <p>
        Orders on {site.tradeName} are delivered from the business to you by an independent rider, or by the
        business&apos;s own courier. This page explains where {site.tradeName} delivers, what delivery costs, and what
        happens when a delivery cannot be completed.
      </p>

      <h2>Where {site.tradeName} delivers</h2>
      <ul>
        <li>
          {site.tradeName} operates in {launch.markets.join(' and ')}, and the nearby areas each store delivers to.
        </li>
        <li>
          Each store sets its own delivery radius. A store delivers only to addresses inside it: the app shows you the
          stores that deliver to your address, and an order to an address outside a store&apos;s radius is refused
          before it is placed.
        </li>
        {/* OWNER MUST APPROVE: business commitment. */}
        <li>
          <b>No deliveries outside {site.country}, and no exports.</b> {site.tradeName} operates only in{' '}
          {site.country} and does not ship goods abroad.
        </li>
      </ul>

      <h2>What delivery costs</h2>
      <ul>
        <li>
          The delivery fee depends on distance: a base fee covers the first part of the trip, and a per-kilometre rate
          applies beyond it. You see the exact fee in your cart and at checkout, before you place the order.
        </li>
        <li>Express delivery, where offered, costs one and a half times the standard delivery fee.</li>
        <li>{site.tradeName} takes no part of the delivery fee and adds nothing to the store&apos;s prices.</li>
        <li>
          Prices are in {site.currencyName} ({site.currencyCode}). You pay in cash when the order is handed over, or by
          MMG straight to the business.
        </li>
      </ul>

      <h2>Pickup instead of delivery</h2>
      <p>
        You can choose pickup at checkout and collect the order from the business yourself. A pickup order has no
        delivery fee.
      </p>

      <h2>Delivery times</h2>
      <p>
        The preparation and arrival times shown in the app are estimates, updated as the rider moves. Preparation,
        traffic and weather can change them.
      </p>

      <h2>If a delivery cannot be completed</h2>
      <ul>
        <li>
          When the rider reaches your address, they mark their arrival. They must then wait at least 5 minutes before
          they can report that you were not there.
        </li>
        <li>
          If you are not there, or you refuse to pay for the order, the delivery is recorded as failed and the order is
          closed. You are told when this happens, and support can review the evidence if you disagree.
        </li>
        <li>
          A failed delivery counts against your account (a strike) only when the evidence supports it, such as the
          rider&apos;s location at your address; never on the rider&apos;s word alone.
        </li>
        <li>
          Strikes count for 90 days. After repeated failed deliveries you must verify your identity before ordering
          again; after more, ordering is switched off until you contact support.
        </li>
      </ul>

      <h2>Contact</h2>
      <p>
        Questions about a delivery: <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a> or{' '}
        <a href={`tel:${site.phone.replace(/[^\d+]/g, '')}`}>{site.phone}</a>.
      </p>
    </PolicyDocument>
  );
}
