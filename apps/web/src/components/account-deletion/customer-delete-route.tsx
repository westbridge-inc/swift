'use client';

import { useWebOrderingOpen, useWebOrderingSoon } from '@/lib/use-web-ordering';

/** The customer's website route once customer pages are open (the phone's Profile > Personal data). */
export const CUSTOMER_ROUTE_OPEN = 'A customer: Account, then Personal details, then Delete my account';
/** Before launch the public site has no customer pages (every /account page answers "Launching soon"). */
export const CUSTOMER_ROUTE_SOON = 'A customer: customer pages open on the website at launch. Until then, delete the account in the app (above), or by email (below)';
/** True in both states, for the moment the server's answer is not known (and for a reader without scripts). */
export const CUSTOMER_ROUTE_NEUTRAL = 'A customer: Account, then Personal details, then Delete my account, once customer pages are open on the website. Until then, in the app (above), or by email (below)';

/**
 * [FLOW-QA2 NEW-2] The public deletion page told customers to use Account > Personal details on the website, which
 * before launch is the "Launching soon" page. The same server answer as the rest of the site decides
 * (lib/use-web-ordering.ts): open (live on the public site, or staging and local runs) names the website route;
 * "soon" says it opens at launch and points to the app and email; unknown says a sentence true in both.
 */
export function CustomerDeleteRoute() {
  const open = useWebOrderingOpen();
  const soon = useWebOrderingSoon();
  if (!open) return <li data-customer-delete-route>{soon ? CUSTOMER_ROUTE_SOON : CUSTOMER_ROUTE_NEUTRAL}</li>;
  return <li data-customer-delete-route>A customer: <b>Account</b>, then <b>Personal details</b>, then <b>Delete my account</b></li>;
}
