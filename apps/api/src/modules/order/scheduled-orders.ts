import { AppError } from '../../utils/errors';

/** Food/shop release jobs are not available at launch. This switch belongs
 * only to cart/checkout ingress; service appointments have their own lifecycle. */
export function assertOrderSchedulingAvailable(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env['SCHEDULED_ORDERS_ENABLED'] === 'true') return;
  // Check before schema parsing: an unknown cart field must not be stripped
  // and turn a request for later into an immediate cart change or order.
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'scheduledFor')) {
    throw new AppError(409, 'SCHEDULED_ORDERS_UNAVAILABLE',
      'Scheduled orders are not available yet. Place your order when you are ready.');
  }
}
