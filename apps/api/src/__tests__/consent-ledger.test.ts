import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  publishLegalDocument, recordConsent, currentConsent, mayReceiveMarketing,
  hashDocument, hashIp, REQUIRED_CONSENTS,
} from '../modules/legal/consent.service';

// [DCR-1 NR-1] The consent ledger is evidence, not bookkeeping: hash-anchored
// to the exact text, append-only at the DATABASE (a withdrawal is a new row),
// and atomic with account creation.
let app: FastifyInstance;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
});

// No row cleanup: the table is append-only BY DESIGN — the trigger this suite
// proves would (correctly) block its own janitor. Subject ids are nanoid-fresh
// per run, so residue cannot collide.
afterAll(async () => {
  await app.close();
});

describe('consent ledger [DCR-1 NR-1]', () => {
  it('anchors consent to the sha256 of the exact text the user saw', async () => {
    const version = `t-${nanoid(8)}`;
    const text = '<h1>Terms</h1><p>Version A</p>';
    const { contentHash } = await publishLegalDocument(app.prisma, {
      documentType: 'terms_of_service', version, renderedText: text,
    });
    expect(contentHash).toBe(hashDocument(text));

    const subjectId = `sub-${nanoid(10)}`;
    await app.prisma.$transaction(async (tx) => {
      await recordConsent(tx, {
        subjectType: 'customer', subjectId, documentType: 'terms_of_service',
        version, action: 'granted', surface: 'ios', ip: '198.51.100.7',
      });
    });
    const row = await app.prisma.consentRecord.findFirstOrThrow({ where: { subjectId } });
    expect(row.documentContentHash).toBe(contentHash);
    expect(row.action).toBe('granted');
  });

  it('refuses consent against a draft or unknown version — anchored to nothing is not consent', async () => {
    const subjectId = `sub-${nanoid(10)}`;
    await expect(app.prisma.$transaction(async (tx) => {
      await recordConsent(tx, {
        subjectType: 'customer', subjectId, documentType: 'privacy_policy',
        version: `never-published-${nanoid(6)}`, action: 'granted', surface: 'web',
      });
    })).rejects.toThrow(/no PUBLISHED/);
    expect(await app.prisma.consentRecord.count({ where: { subjectId } })).toBe(0);
  });

  it('refuses to redefine a published version with different text', async () => {
    const version = `t-${nanoid(8)}`;
    await publishLegalDocument(app.prisma, {
      documentType: 'privacy_policy', version, renderedText: 'original words',
    });
    await expect(publishLegalDocument(app.prisma, {
      documentType: 'privacy_policy', version, renderedText: 'DIFFERENT words',
    })).rejects.toThrow(/already published with different text/);
  });

  it('is APPEND-ONLY at the database — updates and deletes raise, even for the service role', async () => {
    const version = `t-${nanoid(8)}`;
    await publishLegalDocument(app.prisma, {
      documentType: 'marketing_consent', version, renderedText: 'marketing terms',
    });
    const subjectId = `sub-${nanoid(10)}`;
    await app.prisma.$transaction(async (tx) => {
      await recordConsent(tx, {
        subjectType: 'customer', subjectId, documentType: 'marketing_consent',
        version, action: 'granted', surface: 'android',
      });
    });
    const row = await app.prisma.consentRecord.findFirstOrThrow({ where: { subjectId } });

    await expect(app.prisma.$executeRawUnsafe(
      `UPDATE consent_records SET action = 'withdrawn' WHERE id = $1`, row.id,
    )).rejects.toThrow(/append-only/);
    await expect(app.prisma.$executeRawUnsafe(
      `DELETE FROM consent_records WHERE id = $1`, row.id,
    )).rejects.toThrow(/append-only/);

    // The row survived both attempts.
    expect(await app.prisma.consentRecord.count({ where: { subjectId } })).toBe(1);
  });

  it('withdrawal is a NEW ROW that flips current state and stops marketing', async () => {
    const version = `t-${nanoid(8)}`;
    await publishLegalDocument(app.prisma, {
      documentType: 'marketing_consent', version, renderedText: 'marketing terms v2',
    });
    const subjectId = `sub-${nanoid(10)}`;
    await app.prisma.$transaction(async (tx) => {
      await recordConsent(tx, {
        subjectType: 'customer', subjectId, documentType: 'marketing_consent',
        version, action: 'granted', surface: 'ios',
      });
    });
    expect(await mayReceiveMarketing(app.prisma, 'customer', subjectId)).toBe(true);

    await new Promise((r) => setTimeout(r, 5)); // distinct capturedAt
    await app.prisma.$transaction(async (tx) => {
      await recordConsent(tx, {
        subjectType: 'customer', subjectId, documentType: 'marketing_consent',
        version, action: 'withdrawn', surface: 'ios',
      });
    });
    expect(await currentConsent(app.prisma, 'customer', subjectId, 'marketing_consent')).toBe('withdrawn');
    expect(await mayReceiveMarketing(app.prisma, 'customer', subjectId)).toBe(false);
    // History is intact — both rows survive.
    expect(await app.prisma.consentRecord.count({ where: { subjectId } })).toBe(2);
  });

  it('never stores a raw IP — only a peppered HMAC', async () => {
    const prev = process.env['CONSENT_IP_PEPPER'];
    process.env['CONSENT_IP_PEPPER'] = 'x'.repeat(40);
    try {
      const h = hashIp('198.51.100.7');
      expect(h).toBeTruthy();
      expect(h).not.toContain('198.51.100.7');
      expect(h).toHaveLength(64);
      // No pepper configured → no pseudo-identifier stored at all.
      process.env['CONSENT_IP_PEPPER'] = 'too-short';
      expect(hashIp('198.51.100.7')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['CONSENT_IP_PEPPER'];
      else process.env['CONSENT_IP_PEPPER'] = prev;
    }
  });

  it('declares the required document set per subject type [INV-NR1a]', () => {
    expect(REQUIRED_CONSENTS.customer).toEqual(['privacy_policy', 'terms_of_service']);
    expect(REQUIRED_CONSENTS.driver).toContain('driver_agreement');
    expect(REQUIRED_CONSENTS.vendor_user).toContain('vendor_agreement');
  });
});
