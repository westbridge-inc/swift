import { PolicyDocument, policyMetadata } from '@/components/policy-document';
import { site, launch } from '@/site.config';

/**
 * [Q36 item 3] Refunds and cancellations, as Swift works today. Each rule is
 * read from the code, not hoped for:
 *  - orders are paid to the business (cash at handover, or the business's own
 *    MMG); the API refuses any other order payment and Swift holds no order
 *    money — so Swift cannot refund order money itself;
 *  - cancelling follows the ONE cancel-policy predicate in the API
 *    (modules/order/cancel-policy.ts) and its charge path (order.service.ts);
 *  - the weekly partner fee is paid in advance, one week at a time, and
 *    stopping a plan ends future charges (modules/billing/billing.service.ts).
 * Approved by the owner, 1 Oct 2026: the business commitments marked below.
 */

const UPDATED = '1 October 2026';

export const metadata = policyMetadata(
  'Refunds and cancellations',
  `How cancelling an order works on ${site.tradeName}, how order money is refunded, and how the weekly partner fee is charged and refunded.`,
  '/legal/refunds',
);

export default function RefundsPage() {
  const cardsLive = launch.cardPayments === 'live';
  const email = (
    <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
  );
  const phone = <a href={`tel:${site.phone.replace(/[^\d+]/g, '')}`}>{site.phone}</a>;

  return (
    <PolicyDocument title="Refunds and cancellations" updated={UPDATED}>
      <p>
        {site.tradeName} is a marketplace. When you order, you buy from the business, and {site.tradeName} supplies the
        software that connects you. This page explains what happens to your money when an order is cancelled or goes
        wrong, and how {site.tradeName}&apos;s own fee works for the businesses, riders and drivers who pay it.
      </p>

      <h2>How you pay for an order</h2>
      <p>
        You pay the business, never {site.tradeName}: in cash when the order is handed over to you, or by MMG straight
        into the business&apos;s own MMG account, where the business offers it. {site.tradeName} never holds, collects
        or passes on order money, and takes no commission. Cards are not used to pay for orders.
      </p>

      <h2>Cancelling an order</h2>
      <ul>
        <li>
          <b>Before the business accepts your order</b>, and before a rider or driver is assigned, cancelling is free
          for at least the first 5 minutes after you place it. For an order scheduled for later, or a booking, it stays
          free until 5 minutes before the scheduled time. The app shows how long the free window lasts.
        </li>
        <li>
          <b>After the business accepts it</b>, or once a rider or driver has been assigned, you can still cancel until
          the order is on its way. The app then shows that the cancellation is late, and the late-cancellation fee,
          before you confirm. {site.tradeName} does not collect that fee; the late cancellation is recorded on your
          account.
        </li>
        <li>
          <b>Once the order is on its way</b> (the rider has collected it, or you are in the taxi), it can no longer be
          cancelled.
        </li>
        <li>
          <b>Paid by MMG, and the business has confirmed your payment:</b> the app cannot cancel the order for you. Ask
          the business to cancel it. The business refunds you directly to your MMG, because the money is in its
          account, not {site.tradeName}&apos;s.
        </li>
        <li>
          <b>Paid by MMG, but the business has not confirmed it yet:</b> you can cancel in the app. If your payment had
          already gone through, the business refunds it to you directly.
        </li>
        <li>
          <b>Paying cash:</b> you pay only when the order is handed over, so there is nothing to refund on a cancelled
          cash order.
        </li>
      </ul>

      {/* Approved by the owner, 1 Oct 2026. No automatic refund exists; Swift can only help. */}
      <h2>If an MMG-paid order is cancelled or never arrives</h2>
      <p>
        Contact the business first and ask for your refund. If the business does not refund you, contact{' '}
        {site.tradeName} support at {email} or {phone} with your order number. {site.tradeName} will contact the
        business, share the order record with you both, and help you get your money back from the business.{' '}
        {site.tradeName} cannot send the refund itself, because order money never passes through {site.tradeName}, and
        there is no automatic refund. If something is wrong with an order you received, report it the same way; any
        refund of order money is made by the business.
      </p>

      {/* Approved by the owner, 1 Oct 2026: this whole section is a business commitment. */}
      <h2>The weekly partner fee</h2>
      <p>
        Businesses, riders and drivers pay {site.tradeName} a flat weekly fee for the software. Customers pay{' '}
        {site.tradeName} nothing. Advertising that a business chooses to buy is covered by the separate advertising
        terms.
      </p>
      <ul>
        <li>
          <b>Paid in advance.</b> Each payment covers the week that starts on its due date. Today the fee is paid by
          MMG.{' '}
          {cardsLive ? 'It can also be paid by Visa or Mastercard, through our bank’s card payment page.' : null}
        </li>
        <li>
          <b>Charged twice, or by mistake?</b> {site.tradeName} refunds the extra or mistaken charge in full, to the
          method you paid with, once you tell support at {email} or {phone}. Support replies within{' '}
          {site.supportReplyBusinessDays} business days.
        </li>
        <li>
          <b>Stopping your plan.</b> When you stop your weekly plan, {site.tradeName} stops charging for the weeks
          after it. A week that has already started is not refunded, and a fee already owed stays owed.
        </li>
      </ul>

      <h2>Contact</h2>
      <p>
        Refund or billing questions: {email} or {phone}. Prices on {site.tradeName} are in {site.currencyName} (
        {site.currencyCode}).
      </p>
    </PolicyDocument>
  );
}
