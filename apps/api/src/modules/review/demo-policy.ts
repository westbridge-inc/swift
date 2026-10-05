/**
 * [STA-1 DL-5] The store-review fiction has no money rail and moves nothing.
 *
 * A reviewer signed in to a REVIEW tenant browses the content pack's
 * fictional stores, fills a cart and reaches checkout like any customer. The
 * order itself is refused HERE, before anything is written: no order, no
 * outbox row, no vendor alert ladder (whose last rung is an SMS), no MMG
 * hand-off, no dispatch. The words are the ones the app shows under the
 * Place-order button.
 */
import { AppError } from '../../utils/errors';

export const REVIEW_DEMO_NO_ORDERS = 'REVIEW_DEMO_NO_ORDERS';
export const REVIEW_DEMO_NO_ORDERS_MESSAGE =
  "This is Swift's App Review demo: these stores and menus are fictional, so orders can't be placed here. Nothing was charged and nobody was contacted.";

export class ReviewDemoOrderRefusedError extends AppError {
  constructor() {
    super(403, REVIEW_DEMO_NO_ORDERS, REVIEW_DEMO_NO_ORDERS_MESSAGE);
    this.name = 'ReviewDemoOrderRefusedError';
  }
}
