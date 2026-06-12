import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { aiRoutes } from '../modules/ai/ai.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { AiService } from '../modules/ai/ai.service';
import { scrubPrompt } from '../modules/ai/scrubber';

// ---------------------------------------------------------------------------
// Step 12 — AI strictly on top. The import boundary fails the suite if any
// money/auth/state module ever touches the AI layer; the scrubber keeps
// PII/documents/payment data out of prompts; and with no API key the app
// degrades gracefully (deterministic paths only — no live API in tests).
// ---------------------------------------------------------------------------

const PHONE = '+5920015501';
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  // Never call the live API from tests — even when a local key exists
  delete process.env['ANTHROPIC_API_KEY'];
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(aiRoutes, { prefix: '/api/v1/ai' });
  await app.ready();

  await app.prisma.user.deleteMany({ where: { phone: PHONE } });
  const user = await app.prisma.user.create({
    data: {
      phone: PHONE, firstName: 'Ai', lastName: 'Tester',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step12', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { phone: PHONE } });
  await app.close();
});

describe('Import boundary — money never touches AI (build-failing check)', () => {
  const FORBIDDEN_DIRS = [
    'modules/order', 'modules/billing', 'modules/auth', 'modules/verification',
    'modules/dispatch', 'modules/cash', 'modules/booking', 'modules/rides',
    'plugins', 'jobs', 'providers/payment', 'providers/kyc',
  ];

  function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) out.push(full);
      }
    };
    walk(dir);
    return out;
  }

  it('no protected module imports the AI layer', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const offenders: string[] = [];

    for (const dir of FORBIDDEN_DIRS) {
      const abs = path.join(srcRoot, dir);
      let files: string[] = [];
      try {
        files = tsFilesUnder(abs);
      } catch {
        continue; // dir may not exist
      }
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*modules\/ai/.test(content) || /from\s+['"]\.\.?\/ai\//.test(content)) {
          offenders.push(path.relative(srcRoot, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('Prompt scrubber — hard rule 3 proven', () => {
  it('strips phones, emails, cards, tokens, document refs, and opaque ids', () => {
    const dirty = [
      'Call me at +5926001234 or 6471234.',
      'Email: customer@example.com.',
      'Card 4242 4242 4242 4242 please charge it.',
      'Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
      'My ID photo is at storage://kyc/national_id.jpg and /uploads/items/v1/photo.png',
      'order cmqbgitqo000p6nsr240nao2n failed',
    ].join(' ');

    const clean = scrubPrompt(dirty);
    expect(clean).not.toMatch(/\+?\d{7}/);
    expect(clean).not.toContain('@example.com');
    expect(clean).not.toContain('4242');
    expect(clean).not.toContain('eyJ');
    expect(clean).not.toContain('storage://');
    expect(clean).not.toContain('/uploads/');
    expect(clean).not.toContain('cmqbgitqo000p6nsr240nao2n');
    expect(clean).toContain('[redacted-phone]');
    expect(clean).toContain('[redacted-email]');
    expect(clean).toContain('[redacted-card]');
    expect(clean).toContain('[redacted-document]');
  });

  it('leaves harmless text alone', () => {
    const text = 'cheap lunch near me, open now, under 2 thousand';
    expect(scrubPrompt(text)).toBe(text);
  });
});

describe('Graceful degradation — the app works fully without the API', () => {
  it('AiService with no key returns null instantly for every method', async () => {
    const ai = new AiService(undefined);
    expect(ai.enabled).toBe(false);
    expect(await ai.searchIntent('cheap lunch near me')).toBeNull();
    expect(await ai.polishMenuText('fresh juicy burger!!')).toBeNull();
    expect(await ai.summarizeDispute(['a', 'b'])).toBeNull();
  });

  it('the endpoints answer available:false instead of failing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/search-intent',
      payload: { query: 'cheap lunch near me open now' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.available).toBe(false);
    expect(res.json().data.intent).toBeNull();

    const polish = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/menu-polish',
      payload: { text: 'best burger in town very nice' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(polish.statusCode).toBe(200);
    expect(polish.json().data.available).toBe(false);
  });
});
