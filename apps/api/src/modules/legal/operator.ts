/**
 * [Owner 15 Oct 2026 · ruling #63 · legal research Part 4 (A11, E2)] Who operates Swift and sells the partners'
 * weekly fee: the ONE place the company's identity is written. The Terms (operator and contact), the Privacy
 * Policy (data controller and data protection officer), the Mover and Business Agreements (the seller of the
 * weekly fee), the weekly-fee receipts the API returns, and the website's company facts (through the
 * legal:sync snapshot) all read it from here. Public business details, not personal data.
 */
export const OPERATOR = {
  name: 'Westbridge Inc.',
  tradingAs: 'Swift',
  registeredIn: 'Guyana',
  registrationNo: '17703',
  registeredAddress: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara',
  phone: '+592 716 3534',
  supportEmail: 'support@swiftgy.com',
  privacyEmail: 'privacy@swiftgy.com',
  /** The data protection officer, named by role (owner 15 Oct 2026). */
  dpoRole: 'Data Protection Officer, Westbridge Inc.',
} as const;

/** The registered address with its country, one line: how every text writes it. */
export const OPERATOR_ADDRESS = `${OPERATOR.registeredAddress}, ${OPERATOR.registeredIn}`;
