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
 *    stopping a plan ends future charges (modules/billing/billing.service.ts);
 *  - it is paid one week at a time: while a week runs the coming week may be
 *    paid, and no further (modules/billing/pay-ahead.ts, owner #62), and
 *    closing an account waits until a fee paid for a week that has not
 *    started is refunded (modules/user/partner-wind-down.ts, FEE_CREDIT).
 *  - [BOOK-S7 · owner B1/B2 28 Oct 2026] while instant appointment booking
 *    (INSTANT_BOOKING) is switched on, a confirmed appointment cancels free
 *    until 2 hours before it starts, never less than 1 minute after it was
 *    confirmed (cancel-policy.ts), and the customer's own move stops 2 hours
 *    before it starts (reschedule-policy.ts); with it off, the 1-minute
 *    booking rule above stands. Terms §7 says the same (pinned in the API's
 *    legal-appointment-rules.test.ts).
 *  - [TERMS · owner 29 Oct 2026] the same rule for a time booked from a
 *    provider's list of services (book-a-pro: cancel-policy.ts
 *    serviceJobCancelVerdict), plus the provider's move and the free cancel
 *    once the provider is 30 minutes late and has not started; with the switch
 *    off such a job keeps the service job rule below.
 * Approved by the owner, 1 Oct 2026: the business commitments marked below.
 * Owner ruling, 8 Oct 2026: the refund at closing. Owner #62, 14 Oct 2026: one
 * week at a time, no paying ahead (was a four-week limit).
 */

const UPDATED = '29 October 2026';

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
          <b>Before the business accepts your order</b>, cancelling is free, however long it has been waiting
          (unless you paid by MMG and the business has already confirmed your payment: see below).
        </li>
        <li>
          <b>After the business accepts it</b>, the order can no longer be cancelled in the app. Contact the business to
          change or cancel it: the app shows the phone number the business published. You can still cancel it free in
          the app if no rider could be found for it, or if it is running very late (for example, 60 minutes past the
          time you were promised).
        </li>
        <li>
          <b>Rides, parcels and bookings</b> can be cancelled free at any time while nobody has accepted them, and for
          1 minute after a driver, rider or provider accepts them. After that, contact your driver, rider or provider.
          You can still cancel free if no driver or rider was found, or if they are running very late, as the app shows.
        </li>
        <li>
          <b>Appointments</b> (a time you book from a business&apos;s listing or from a provider&apos;s list of
          services): while {site.tradeName}&apos;s instant appointment booking is switched on, an appointment the
          business or provider has confirmed can be cancelled free in the app until 2 hours before it starts, and always
          for at least 1 minute after it was confirmed. Where the app offers it, you can also move it to another free
          time of the same service until 2 hours before it starts. After that, contact the business or provider to change
          or cancel it. The business can also move your appointment, and you are told in the app when it does. While
          instant appointment booking is switched on, a provider can also move an appointment booked from their list of
          services, and you are told in the app when they do; if the provider has not started it 30 minutes after its
          start time, you can still cancel it free in the app.
        </li>
        <li>
          <b>Any other service job</b> (a local pro you hired through the app) can be cancelled free in the app while it
          is a request, until the job is booked. Once it is booked, contact the provider to change or cancel it.
        </li>
        <li>
          <b>Once the order is on its way</b> (the rider has collected it, or you are in the taxi), it can no longer be
          cancelled.
        </li>
        <li>
          <b>{site.tradeName} never charges a cancellation fee.</b>
        </li>
        <li>
          <b>Paid by MMG, and the business has confirmed your payment:</b> the app cannot cancel the order for you. Ask
          the business to cancel it. The business refunds you directly to your MMG, because the money is in its
          account, not {site.tradeName}&apos;s.
        </li>
        <li>
          <b>Paid by MMG, but the business has not confirmed your payment yet:</b> you can cancel in the app. If your
          payment had already gone through, the business refunds it to you directly.
        </li>
        <li>
          <b>Paying cash:</b> you pay only when the order is handed over, so there is nothing to refund on a cancelled
          cash order.
        </li>
      </ul>
      {/* [Legal research E5] statutory rights are never displaced by these rules. */}
      <p>
        These rules do not affect your rights under the Consumer Affairs Act 2011 to return goods or get a refund from
        the business.
      </p>

      {/* Approved by the owner, 1 Oct 2026. No automatic refund exists; Swift can only help. */}
      <h2>If an MMG-paid order is cancelled or never arrives</h2>
      <p>
        Contact the business first and ask for your refund. If the business does not refund you, contact{' '}
        {site.tradeName} support at {email} or {phone} with your order number. {site.tradeName} will contact the
        business, share the order record with you both, and help you get your money back from the business.{' '}
        {site.tradeName} cannot send the refund itself, because order money never passes through {site.tradeName}, and
        there is no automatic refund. If something is wrong with an order you received, report it the same way; any
        refund of order money is made by the business. We reply within 2 business days; the business must refund
        within 72 hours of our contact.
      </p>

      {/* Approved by the owner, 1 Oct 2026: this whole section is a business commitment. */}
      <h2>The weekly partner fee</h2>
      <p>
        Businesses, riders and drivers pay {site.tradeName} a flat weekly fee for the software. Customers pay{' '}
        {site.tradeName} nothing.
      </p>
      <ul>
        <li>
          <b>Paid in advance.</b> Each payment covers the week that starts on its due date. Today the fee is paid by
          MMG.{' '}
          {cardsLive ? 'It can also be paid by Visa or Mastercard, through our bank’s card payment page.' : null}
        </li>
        <li>
          <b>Charged twice, or by mistake?</b> {site.tradeName} refunds the extra or mistaken charge in full, within 14
          days, to the method you paid with, once you tell support at {email} or {phone}. Support replies within{' '}
          {site.supportReplyBusinessDays} business days.
        </li>
        <li>
          <b>One week at a time.</b> You pay the fee one week at a time: while a week runs you can pay for the coming
          week, and no further. Money received beyond that is returned to you. A fee paid before its week starts is only
          ever used for that weekly fee.
        </li>
        <li>
          <b>Stopping your plan.</b> When you stop your weekly plan, {site.tradeName} stops charging for the weeks
          after it. A week that has already started is not refunded, and a fee already owed stays owed.
        </li>
        <li>
          <b>Closing your account.</b> {site.tradeName} refunds any weekly fee you paid for a week that has not started,
          within 14 days, to the account you paid from, records the refund, and then deletes your account. A week that has already started is not refunded.
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
