import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../middleware/error-handler';
import { cartMergeSchema } from '../modules/user/cart-merge.service';
import { scheduleSchema } from '../modules/services/service-job-client-contract';
import { settlementAttestationSchema } from '../modules/cash/delivery-cash-settlement.service';

// [DEP-ZOD · GHSA-mrhx-c7xc-m3w5] The exact bytes a 400 VALIDATION_ERROR carried
// on zod 3.25.76, recorded on main (facbe7e29) through the real error handler
// and the real request schemas before the API moved to zod 4. The apps parse
// these bodies; the move must leave every byte as it was. Never re-record them
// from the new zod.
const RECORDED_ON_ZOD3: Array<{ route: string; body: unknown; status: number; bytes: string }> = [
  {
    route: "merge",
    body: {"lines": [{"clientLineId": "", "vendorId": "v1", "itemId": 7, "quantity": 0, "expectedUnitPrice": 1.5, "selectedOptions": {"size": ""}}]},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"lines.0.clientLineId\":[\"String must contain at least 1 character(s)\"],\"lines.0.itemId\":[\"Expected string, received number\"],\"lines.0.quantity\":[\"Number must be greater than or equal to 1\"],\"lines.0.expectedUnitPrice\":[\"Expected integer, received float\"],\"lines.0.selectedOptions.size\":[\"String must contain at least 1 character(s)\"]}}}",
  },
  {
    route: "merge",
    body: {"lines": []},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"lines\":[\"Array must contain at least 1 element(s)\"],\"\":[\"Upload one store basket at a time.\"]}}}",
  },
  {
    route: "merge",
    body: {},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"lines\":[\"Required\"]}}}",
  },
  {
    route: "schedule",
    body: {"expectedUpdatedAt": "not a date", "scheduledFor": "2026-13-45", "expectedQuoteAmount": "12"},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"expectedUpdatedAt\":[\"Invalid date\"],\"scheduledFor\":[\"Invalid date\"],\"expectedQuoteAmount\":[\"Expected number, received string\"]}}}",
  },
  {
    route: "schedule",
    body: {"expectedUpdatedAt": "2026-10-24T10:00:00.000Z"},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"scheduledFor\":[\"Invalid date\"],\"expectedQuoteAmount\":[\"Required\"]}}}",
  },
  {
    route: "attest",
    body: {"amount": true},
    status: 400,
    bytes: "{\"success\":false,\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid request data\",\"details\":{\"amount\":[\"Invalid input\"]}}}",
  },];

describe('a validation 400 answers byte for byte as it did on zod 3', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.post('/merge', async (req) => { cartMergeSchema.parse(req.body); return { ok: true }; });
    app.post('/schedule', async (req) => { scheduleSchema.parse(req.body); return { ok: true }; });
    app.post('/attest', async (req) => { settlementAttestationSchema.parse(req.body); return { ok: true }; });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  RECORDED_ON_ZOD3.forEach((c, i) => {
    it(`case ${i + 1}: POST /${c.route}`, async () => {
      const res = await app.inject({ method: 'POST', url: `/${c.route}`, payload: c.body as object });
      expect(res.statusCode).toBe(c.status);
      expect(res.payload).toBe(c.bytes);
    });
  });
});
