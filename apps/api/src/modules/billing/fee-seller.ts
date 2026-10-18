import { OPERATOR, OPERATOR_ADDRESS } from '../legal/operator';

/**
 * [Owner 15 Oct 2026 · ruling #63 · legal research A11, R2] Who sells the partners' weekly fee: Swift's operator,
 * named on every weekly-fee receipt the API returns (each checkout view), from the ONE constant the Terms and the
 * agreements use. Clients print it as "Sold by …"; an older client ignores the field.
 */
export interface FeeSeller { name: string; tradingAs: string; registrationNo: string; registeredAddress: string; phone: string; email: string }

export const FEE_SELLER: FeeSeller = {
  name: OPERATOR.name,
  tradingAs: OPERATOR.tradingAs,
  registrationNo: OPERATOR.registrationNo,
  registeredAddress: OPERATOR_ADDRESS,
  // [Legal research R2] how to reach the seller: the published support phone and e-mail (one constant; the phone
  // swaps there when the owner's support SIM arrives).
  phone: OPERATOR.phone,
  email: OPERATOR.supportEmail,
};
