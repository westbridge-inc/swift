import { MAX_HIRE_PASSENGERS } from '../../config/vehicle-classes';
import { AppError } from '../../utils/errors';

/** [Owner research R9, 15 Oct 2026] A hire carries at most MAX_HIRE_PASSENGERS (7). A larger party is refused
 *  before anything is priced or written, in words that say what to do. Its own module (no database, no
 *  service) so the route and the request core share one rule, and a test that stubs rides.service never
 *  removes it. */
export function assertHirePassengers(passengerCount: number): void {
  if (passengerCount > MAX_HIRE_PASSENGERS) {
    throw new AppError(400, 'TOO_MANY_PASSENGERS',
      `A Swift taxi carries at most ${MAX_HIRE_PASSENGERS} passengers. For a bigger group, book more than one ride.`,
      { max: MAX_HIRE_PASSENGERS, passengerCount });
  }
}
