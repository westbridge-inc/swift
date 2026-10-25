import type { FastifyInstance } from 'fastify';
import { makeDispatchService } from '../../modules/dispatch/dispatch.service';

/** Explicit acknowledged scheduler double. Delayed jobs are recorded for manual
 * driving; optional immediate dispatch execution models the route-to-worker hop.
 * This does not claim BullMQ durability. Missing/rejected queues are tested by
 * dispatch-lifecycle.unit.test.ts and must never silently become successful. */
export function recordDispatchQueue(app: FastifyInstance, runImmediate = false) {
  const jobs: Array<{
    name: string;
    data: { orderId: string; tenantId?: string; riderId?: string; attemptId?: string };
    options: { delay?: number };
    /** [row 266] Which queue the job was added to: offer timeouts ride their own. */
    queue: 'dispatch' | 'offer';
  }> = [];
  const recorder = (queue: 'dispatch' | 'offer') => ({
    add: async (name: string, data: typeof jobs[number]['data'], options: { delay?: number } = {}) => {
      jobs.push({ name, data, options, queue });
      if (runImmediate && name === 'dispatch-order' && !options.delay) {
        await makeDispatchService(app).dispatchOrder(data.orderId, data.tenantId);
      }
      return { id: `recorded-${jobs.length}` };
    },
  });
  app.decorate('dispatchQueue', recorder('dispatch') as never);
  app.decorate('offerQueue', recorder('offer') as never);
  return jobs;
}
