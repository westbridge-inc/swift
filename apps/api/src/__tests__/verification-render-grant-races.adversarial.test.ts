import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { DOC_REVIEWER_CAPABILITIES } from '../modules/admin/admin-authority';
import { runWithoutTenant } from '../plugins/tenant-context';
import {
  LocalStorageProvider,
  type StorageReadOptions,
} from '../providers/storage/storage-provider';
import { reviewGrantTokenHash } from '../modules/verification/review-access';

const RUN = `${Date.now()}-${nanoid(8)}`;
const DAY_MS = 86_400_000;
const DECISION_REASON = `Adversarial secure-render review ${RUN}`;
const bodyByObjectKey = new Map<string, Buffer>();
const logLines: string[] = [];

type ReadObject = (
  objectKey: string,
  objectVersion?: string,
  options?: StorageReadOptions,
) => Promise<Buffer>;

let app: FastifyInstance;
let sequence = 0;
let readObject: ReadObject;
let getObjectSpy: ReturnType<typeof vi.spyOn>;

const system = <T>(work: () => Promise<T>) => runWithoutTenant(work, 'verification-render-grant-races-adversarial');

function errorCode(response: LightMyRequestResponse): string | undefined {
  const payload = response.json() as { error?: { code?: string }; code?: string };
  return payload.error?.code ?? payload.code;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface ReviewerFixture {
  id: string;
  token: string;
  sessionId: string;
}

interface ReviewFixture {
  reviewer: ReviewerFixture;
  subjectId: string;
  documentId: string;
  caseId: string;
  assignmentEpoch: string;
  providerKey: string;
  plaintext: Buffer;
}

async function createReviewer(): Promise<ReviewerFixture> {
  sequence += 1;
  const reviewer = await system(() => app.prisma.user.create({
    data: {
      phone: `+59266${String(Date.now()).slice(-6)}${String(sequence).padStart(2, '0')}`,
      firstName: 'Grant',
      lastName: `Reviewer${sequence}`,
      roles: ['ADMIN', 'CUSTOMER'],
      activeRole: 'ADMIN',
      status: 'ACTIVE',
      isPhoneVerified: true,
      admin: { create: { permissions: [...DOC_REVIEWER_CAPABILITIES] } },
    },
  }));
  const token = app.jwt.sign({ userId: reviewer.id, role: 'ADMIN', jti: nanoid(12) });
  const session = await system(() => app.prisma.session.create({
    data: {
      userId: reviewer.id,
      token,
      refreshToken: nanoid(48),
      authMethod: 'OTP',
      deviceId: `review-grant-${RUN}-${sequence}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  }));
  return { id: reviewer.id, token, sessionId: session.id };
}

async function createReviewFixture(input: {
  reviewer?: ReviewerFixture;
  encrypted?: boolean;
  createEnvelope?: boolean;
  plaintext?: Buffer;
} = {}): Promise<ReviewFixture> {
  sequence += 1;
  const reviewer = input.reviewer ?? await createReviewer();
  const subject = await system(() => app.prisma.user.create({
    data: {
      phone: `+59267${String(Date.now()).slice(-6)}${String(sequence).padStart(2, '0')}`,
      firstName: 'Grant',
      lastName: `Subject${sequence}`,
      roles: ['VENDOR_OWNER'],
      activeRole: 'VENDOR_OWNER',
      status: 'ACTIVE',
      isPhoneVerified: true,
    },
  }));
  const plaintext = input.plaintext ?? Buffer.from(`%PDF-1.4\nsecure-render-${RUN}-${sequence}\n%%EOF\n`);
  const sha256 = createHash('sha256').update(plaintext).digest('hex');
  const providerKey = `/uploads/verification/${subject.id}/${RUN}-${sequence}.pdf`;
  const canonicalKey = providerKey.replace(/^\/uploads\//, '');
  const storageLocationId = new LocalStorageProvider().locationId();
  const objectVersion = `sha256:${sha256}`;
  const processingId = randomUUID();
  const processingAt = new Date();

  const document = await system(() => app.prisma.verificationDocument.create({
    data: {
      userId: subject.id,
      role: 'VENDOR_OWNER',
      docType: 'business_registration',
      verificationRoleKey: 'RESTAURANT',
      fileUrl: providerKey,
      status: 'PENDING',
      state: 'IN_REVIEW',
      consentAt: new Date(),
      privacyNoticeVersion: 'test-v1',
    },
  }));
  const upload = await system(() => app.prisma.verificationUpload.create({
    data: {
      tenantId: 'swift-default',
      userId: subject.id,
      storageLocationId,
      providerKey,
      canonicalKey,
      purpose: 'CHECKLIST_DOCUMENT',
      roleKey: 'RESTAURANT',
      docType: 'business_registration',
      mimeType: 'application/pdf',
      sizeBytes: plaintext.length,
      sha256,
      encrypted: input.encrypted ?? false,
      state: 'UPLOADING',
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  }));
  await system(() => app.prisma.verificationUpload.update({
    where: { id: upload.id },
    data: { state: 'UPLOADED', objectVersion },
  }));
  await system(() => app.prisma.verificationUpload.update({
    where: { id: upload.id },
    data: {
      state: 'PROCESSING',
      processingId,
      processingStartedAt: processingAt,
      processingPolicy: 'DOCUMENT_ONLY',
    },
  }));
  await system(() => app.prisma.verificationUpload.update({
    where: { id: upload.id },
    data: {
      state: 'CONSUMED',
      submissionId: document.id,
      consumedAt: processingAt,
    },
  }));
  await system(() => app.prisma.verificationDocument.update({
    where: { id: document.id },
    data: { storageProvenance: 'VERIFIED' },
  }));

  if (input.createEnvelope) {
    await system(() => app.prisma.encryptedObject.create({
      data: {
        fileKey: providerKey,
        iv: Buffer.alloc(12, 1),
        authTag: Buffer.alloc(16, 2),
        wrappedDek: Buffer.alloc(60, 3),
        mimeType: 'application/pdf',
        sizeBytes: plaintext.length,
        sha256,
        createdBy: subject.id,
      },
    }));
  }

  const assignmentEpoch = randomUUID();
  const reviewCase = await system(() => app.prisma.reviewCase.create({
    data: {
      tenantId: 'swift-default',
      submissionId: document.id,
      slaDueAt: new Date(Date.now() + DAY_MS),
      assignedTo: reviewer.id,
      assignedAt: new Date(),
      assignmentEpoch,
    },
  }));
  bodyByObjectKey.set(providerKey, plaintext);
  return {
    reviewer,
    subjectId: subject.id,
    documentId: document.id,
    caseId: reviewCase.id,
    assignmentEpoch,
    providerKey,
    plaintext,
  };
}

function requestHeaders(reviewer: ReviewerFixture): Record<string, string> {
  return {
    authorization: `Bearer ${reviewer.token}`,
    'content-type': 'application/json',
    'x-swift-reason': DECISION_REASON,
  };
}

async function mintGrant(fixture: ReviewFixture): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/verification/${fixture.documentId}/document-url`,
    headers: requestHeaders(fixture.reviewer),
  });
  expect(response.statusCode, response.body).toBe(200);
  const token = (response.json() as { data: { reviewGrantToken: string } }).data.reviewGrantToken;
  expect(token).toHaveLength(43);
  return token;
}

async function render(fixture: ReviewFixture, token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/verification/${fixture.documentId}/render`,
    headers: { ...requestHeaders(fixture.reviewer), 'x-swift-review-grant': token },
  });
}

async function acknowledge(fixture: ReviewFixture, token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/admin/verification/${fixture.documentId}/render-ack`,
    headers: requestHeaders(fixture.reviewer),
    payload: { reviewGrantToken: token },
  });
}

async function grantRow(token: string) {
  return system(() => app.prisma.reviewRenderGrant.findUniqueOrThrow({
    where: { tokenHash: reviewGrantTokenHash(token) },
  }));
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['STORAGE_PROVIDER'] = 'local';
  process.env['UPLOAD_DIR'] = `/tmp/swift-review-grant-${RUN}`;
  app = Fastify({
    logger: {
      level: 'warn',
      stream: { write: (line: string) => { logLines.push(line); } },
    },
  });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  readObject = async (objectKey, _objectVersion, options) => {
    options?.signal?.throwIfAborted();
    const body = bodyByObjectKey.get(objectKey);
    if (!body) throw new Error('test object is absent');
    return Buffer.from(body);
  };
  getObjectSpy = vi.spyOn(LocalStorageProvider.prototype, 'getObject').mockImplementation(
    (objectKey, objectVersion, options) => readObject(objectKey, objectVersion, options),
  );
});

beforeEach(() => {
  logLines.length = 0;
  readObject = async (objectKey, _objectVersion, options) => {
    options?.signal?.throwIfAborted();
    const body = bodyByObjectKey.get(objectKey);
    if (!body) throw new Error('test object is absent');
    return Buffer.from(body);
  };
});

afterAll(async () => {
  getObjectSpy.mockRestore();
  await app.close();
});

describe('secure verification render grants under adversarial races', () => {
  it('does not release bytes when the bound session expires during external object work', async () => {
    const fixture = await createReviewFixture();
    const token = await mintGrant(fixture);
    const started = deferred();
    const release = deferred();
    readObject = async (key) => {
      started.resolve();
      await release.promise;
      return Buffer.from(bodyByObjectKey.get(key)!);
    };

    const pending = render(fixture, token);
    await started.promise;
    await system(() => app.prisma.session.update({
      where: { id: fixture.reviewer.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    }));
    release.resolve();
    const response = await pending;

    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('REVIEW_SESSION_REVOKED');
    expect(response.body).not.toContain(fixture.plaintext.toString('utf8'));
    expect((await grantRow(token)).fetchedAt).toBeNull();
    expect(await system(() => app.prisma.sensitiveReadLog.count({
      where: { subjectId: fixture.documentId, action: 'FETCH_VERIFICATION_DOCUMENT' },
    }))).toBe(0);
  });

  it('does not release bytes when document-read capability is revoked during external object work', async () => {
    const fixture = await createReviewFixture();
    const token = await mintGrant(fixture);
    const started = deferred();
    const release = deferred();
    readObject = async (key) => {
      started.resolve();
      await release.promise;
      return Buffer.from(bodyByObjectKey.get(key)!);
    };

    const pending = render(fixture, token);
    await started.promise;
    await system(() => app.prisma.admin.update({
      where: { userId: fixture.reviewer.id },
      data: { permissions: ['verification.case.claim'] },
    }));
    release.resolve();
    const response = await pending;

    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('REVIEWER_CAPABILITY_REVOKED');
    expect(response.body).not.toContain(fixture.plaintext.toString('utf8'));
    expect((await grantRow(token)).fetchedAt).toBeNull();
  });

  it('revokes a minted-never-fetched grant on release and rejects it after same-reviewer reclaim with a new epoch', async () => {
    const fixture = await createReviewFixture();
    const token = await mintGrant(fixture);
    expect(await grantRow(token)).toMatchObject({
      assignmentEpoch: fixture.assignmentEpoch,
      reservedAt: null,
      fetchedAt: null,
      acknowledgedAt: null,
      revokedAt: null,
    });

    const released = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/verification/cases/${fixture.caseId}/release`,
      headers: requestHeaders(fixture.reviewer),
      payload: {},
    });
    expect(released.statusCode, released.body).toBe(200);
    expect((await grantRow(token)).revokedAt).toBeInstanceOf(Date);

    const reclaimed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/verification/cases/${fixture.caseId}/claim`,
      headers: requestHeaders(fixture.reviewer),
      payload: {},
    });
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
    const current = await system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id: fixture.caseId } }));
    expect(current.assignmentEpoch).not.toBe(fixture.assignmentEpoch);

    const replay = await render(fixture, token);
    expect(replay.statusCode).toBe(409);
    expect(errorCode(replay)).toBe('REVIEW_GRANT_STALE');
  });

  it('withholds already-read bytes when release and same-reviewer reclaim create an ABA during external storage work', async () => {
    const fixture = await createReviewFixture();
    const token = await mintGrant(fixture);
    const started = deferred();
    const releaseStorage = deferred();
    readObject = async (key) => {
      started.resolve();
      await releaseStorage.promise;
      return Buffer.from(bodyByObjectKey.get(key)!);
    };

    const pending = render(fixture, token);
    await started.promise;
    const released = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/verification/cases/${fixture.caseId}/release`,
      headers: requestHeaders(fixture.reviewer),
      payload: {},
    });
    expect(released.statusCode, released.body).toBe(200);
    const reclaimed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/verification/cases/${fixture.caseId}/claim`,
      headers: requestHeaders(fixture.reviewer),
      payload: {},
    });
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
    const newEpoch = (await system(() => app.prisma.reviewCase.findUniqueOrThrow({
      where: { id: fixture.caseId },
    }))).assignmentEpoch;
    expect(newEpoch).not.toBe(fixture.assignmentEpoch);

    releaseStorage.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('REVIEW_GRANT_STALE');
    expect(response.body).not.toContain(fixture.plaintext.toString('utf8'));
    expect(await grantRow(token)).toMatchObject({ fetchedAt: null, revokedAt: expect.any(Date) });
    expect(await system(() => app.prisma.sensitiveReadLog.count({
      where: { subjectId: fixture.documentId, action: 'FETCH_VERIFICATION_DOCUMENT' },
    }))).toBe(0);
  });

  it('binds a decision to the one fetched-and-acknowledged grant, not another unused grant from the same assignment', async () => {
    const fixture = await createReviewFixture();
    const renderedToken = await mintGrant(fixture);
    const unusedToken = await mintGrant(fixture);
    const fetched = await render(fixture, renderedToken);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.rawPayload.equals(fixture.plaintext)).toBe(true);
    const ack = await acknowledge(fixture, renderedToken);
    expect(ack.statusCode, ack.body).toBe(200);

    const refused = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/verification/${fixture.documentId}/reject`,
      headers: requestHeaders(fixture.reviewer),
      payload: {
        reason: DECISION_REASON,
        reasonCode: 'UNREADABLE',
        reviewGrantToken: unusedToken,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('DOCUMENT_RENDER_ACK_REQUIRED');
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: fixture.documentId } }))).status).toBe('PENDING');
    expect((await grantRow(renderedToken)).consumedAt).toBeNull();
    expect((await grantRow(unusedToken)).consumedAt).toBeNull();

    const decided = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/verification/${fixture.documentId}/reject`,
      headers: requestHeaders(fixture.reviewer),
      payload: {
        reason: DECISION_REASON,
        reasonCode: 'UNREADABLE',
        reviewGrantToken: renderedToken,
      },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await grantRow(renderedToken)).consumedAt).toBeInstanceOf(Date);
    expect((await grantRow(unusedToken)).revokedAt).toBeInstanceOf(Date);
  });

  it.each([
    { label: 'terminal', mutate: async (fixture: ReviewFixture) => {
      await system(() => app.prisma.verificationDocument.update({
        where: { id: fixture.documentId },
        data: { state: 'REJECTED', status: 'REJECTED' },
      }));
    }, expectedStatus: 409, expectedCode: 'DOCUMENT_NOT_REVIEWABLE' },
    { label: 'purge-pending', mutate: async (fixture: ReviewFixture) => {
      await system(() => app.prisma.verificationDocument.update({
        where: { id: fixture.documentId },
        data: {
          storagePurgeRequestedAt: new Date(),
          storagePurgeMode: 'FULL_RETENTION',
          storagePurgeRequestedBy: fixture.reviewer.id,
        },
      }));
    }, expectedStatus: 410, expectedCode: 'DOCUMENT_PURGED' },
  ])('rejects $label documents before minting any render grant', async ({ mutate, expectedStatus, expectedCode }) => {
    const fixture = await createReviewFixture();
    await mutate(fixture);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/verification/${fixture.documentId}/document-url`,
      headers: requestHeaders(fixture.reviewer),
    });
    expect(response.statusCode).toBe(expectedStatus);
    expect(errorCode(response)).toBe(expectedCode);
    expect(await system(() => app.prisma.reviewRenderGrant.count({ where: { documentId: fixture.documentId } }))).toBe(0);
  });

  it('maps a hostile provider failure to a generic response and logs no object key', async () => {
    const fixture = await createReviewFixture();
    const token = await mintGrant(fixture);
    readObject = async (objectKey) => {
      throw new Error(`provider exploded while reading ${objectKey}`);
    };

    const response = await render(fixture, token);
    expect(response.statusCode).toBe(503);
    expect(errorCode(response)).toBe('DOCUMENT_STORAGE_UNAVAILABLE');
    expect(response.body).not.toContain(fixture.providerKey);
    expect(logLines.join('\n')).not.toContain(fixture.providerKey);
    expect((await grantRow(token)).fetchedAt).toBeNull();
  });

  it('does not mark fetched, log final access, or release bytes when a same-length plaintext has the wrong digest', async () => {
    const fixture = await createReviewFixture({ plaintext: Buffer.from('expected-object-body-0001') });
    const token = await mintGrant(fixture);
    const wrong = Buffer.from('attacker-object-body-0001');
    expect(wrong.length).toBe(fixture.plaintext.length);
    readObject = async () => Buffer.from(wrong);

    const response = await render(fixture, token);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('DOCUMENT_OBJECT_INTEGRITY');
    expect(response.rawPayload.equals(wrong)).toBe(false);
    expect((await grantRow(token)).fetchedAt).toBeNull();
    expect(await system(() => app.prisma.sensitiveReadLog.count({
      where: { subjectId: fixture.documentId, action: 'FETCH_VERIFICATION_DOCUMENT' },
    }))).toBe(0);
  });

  it('rejects an envelope row attached to an upload declared unencrypted', async () => {
    const fixture = await createReviewFixture({ encrypted: false, createEnvelope: true });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/verification/${fixture.documentId}/document-url`,
      headers: requestHeaders(fixture.reviewer),
    });
    expect(response.statusCode).toBe(410);
    expect(errorCode(response)).toBe('DOCUMENT_OWNERSHIP_INVALID');
    expect(await system(() => app.prisma.reviewRenderGrant.count({ where: { documentId: fixture.documentId } }))).toBe(0);
  });

  it('rejects an upload declared encrypted when its envelope is absent', async () => {
    const fixture = await createReviewFixture({ encrypted: true, createEnvelope: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/verification/${fixture.documentId}/document-url`,
      headers: requestHeaders(fixture.reviewer),
    });
    expect(response.statusCode).toBe(410);
    expect(errorCode(response)).toBe('DOCUMENT_OWNERSHIP_INVALID');
    expect(await system(() => app.prisma.reviewRenderGrant.count({ where: { documentId: fixture.documentId } }))).toBe(0);
  });
});
