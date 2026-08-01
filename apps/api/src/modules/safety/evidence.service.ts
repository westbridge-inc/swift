import { createHash, randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import type { PrismaClient, EvidenceBundle, EvidenceItemKind, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';

// Evidence Vault (safety spec §9) — tamper-evident capture of what the
// platform knew, when it knew it. A bundle opens automatically on SOS ACTIVE
// and on S0/S1 case intake; every item is a CANONICAL SNAPSHOT (content +
// SHA-256 at capture), never a live pointer — the order can keep moving, the
// evidence cannot. Sealing stamps every item and computes the bundle
// sealHash; from then on the service refuses writes AND the Postgres
// triggers refuse them (see the migration) — no future code path or raw
// query can quietly rewrite history. Chain of custody: every content view,
// seal, and hold writes a SafetyAccessLog row with a REQUIRED reason.
//
// Deliberately absent (reconciled to the real stack, not silently dropped):
// the spec's pre-trigger GPS trail needs a continuous location ring buffer
// the platform doesn't keep — post-trigger fixes ride the guardian sweep in
// a later slice; audio capture is client-side AND founder-gated on the
// one-party-recording legal review (§9.3).

const unattachedRetentionDays = () => {
  const v = Number(process.env['EVIDENCE_UNATTACHED_RETENTION_DAYS']);
  return Number.isFinite(v) && v > 0 ? v : 7;
};

/** Deterministic serialization — plain-JSON normalize first (Dates → ISO,
 *  Prisma Decimals → their toJSON, undefined dropped — exactly JSON.stringify
 *  semantics), THEN object keys sorted recursively, so the same content
 *  always yields the same hash, whatever produced it. */
export function canonicalJson(value: unknown): string {
  const plain: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
  return sortedJson(plain);
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface CapturedItem {
  kind: EvidenceItemKind;
  label: string;
  content: unknown;
}

export class EvidenceService {
  constructor(private prisma: PrismaClient, private io: Server) {}

  // ── Opening (auto — SOS ACTIVE / S0-S1 intake; idempotent) ───────────────

  /** Open (or return) the bundle for an SOS alert and capture everything the
   *  platform holds about it right now. Unique(sosAlertId) makes racing
   *  opens collapse to one. Best-effort by contract: callers never fail
   *  their own path on a vault hiccup. */
  async openForSos(sosAlertId: string): Promise<EvidenceBundle | null> {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id: sosAlertId } });
    if (!alert) return null;
    const existing = await this.prisma.evidenceBundle.findUnique({ where: { sosAlertId } });
    if (existing) return existing;

    const items: CapturedItem[] = [{ kind: 'SOS_ALERT', label: `SOS alert ${alert.id}`, content: alert }];
    if (alert.deliveryReceipts) items.push({ kind: 'FANOUT_RECEIPTS', label: 'Fan-out delivery receipts at capture', content: alert.deliveryReceipts });
    if (alert.orderId) items.push(...(await this.captureOrderArtifacts(alert.orderId)));
    if (alert.counterpartyUserId) items.push(...(await this.captureLivenessHistory(alert.counterpartyUserId)));

    try {
      return await this.createBundle({ sosAlertId, subjectUserId: alert.counterpartyUserId }, items);
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return this.prisma.evidenceBundle.findUnique({ where: { sosAlertId } }); // racing open won
      }
      throw err;
    }
  }

  /** Open (or return) the bundle for an incident case. */
  async openForCase(caseId: string): Promise<EvidenceBundle | null> {
    const kase = await this.prisma.incidentCase.findUnique({ where: { id: caseId } });
    if (!kase) return null;
    const existing = await this.prisma.evidenceBundle.findUnique({ where: { caseId } });
    if (existing) return existing;

    const items: CapturedItem[] = [{ kind: 'INCIDENT_CASE', label: `Case ${kase.caseNumber} at intake`, content: kase }];
    if (kase.orderId) items.push(...(await this.captureOrderArtifacts(kase.orderId)));
    items.push(...(await this.captureLivenessHistory(kase.subjectUserId)));

    try {
      return await this.createBundle({ caseId, sosAlertId: kase.sosAlertId, subjectUserId: kase.subjectUserId }, items);
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // Either the caseId or the sosAlertId collided (an SOS bundle may
        // already exist for the same alert) — adopt the existing bundle.
        const byCase = await this.prisma.evidenceBundle.findUnique({ where: { caseId } });
        if (byCase) return byCase;
        if (kase.sosAlertId) {
          const bySos = await this.prisma.evidenceBundle.findUnique({ where: { sosAlertId: kase.sosAlertId } });
          if (bySos && !bySos.sealedAt) {
            return this.prisma.evidenceBundle.update({ where: { id: bySos.id }, data: { caseId } });
          }
          return bySos;
        }
        throw err;
      }
      throw err;
    }
  }

  private async createBundle(
    link: { sosAlertId?: string | null; caseId?: string | null; subjectUserId?: string | null },
    items: CapturedItem[],
  ): Promise<EvidenceBundle> {
    const bundle = await this.prisma.evidenceBundle.create({
      data: {
        bundleNumber: `EV-${nanoid(8).toUpperCase()}`,
        sosAlertId: link.sosAlertId ?? null,
        caseId: link.caseId ?? null,
        subjectUserId: link.subjectUserId ?? null,
        items: {
          create: items.map((i) => {
            const canonical = canonicalJson(i.content);
            return { kind: i.kind, label: i.label, content: JSON.parse(canonical) as never, contentHash: sha256(canonical) };
          }),
        },
      },
    });
    log().info({ bundleId: bundle.id, bundleNumber: bundle.bundleNumber, items: items.length }, 'evidence bundle opened');
    return bundle;
  }

  private async captureOrderArtifacts(orderId: string): Promise<CapturedItem[]> {
    const items: CapturedItem[] = [];
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (order) items.push({ kind: 'ORDER_SNAPSHOT', label: `Order ${order.orderNumber} at capture`, content: order });
    const timeline = await this.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take: 200 });
    if (timeline.length) items.push({ kind: 'STATUS_TIMELINE', label: 'Order status timeline', content: timeline });
    const session = await this.prisma.tripSafetySession.findUnique({ where: { orderId } });
    if (session) items.push({ kind: 'GUARDIAN_SESSION', label: 'Trip Guardian session (detector state + ladder log)', content: session });
    const room = await this.prisma.chatRoom.findFirst({ where: { orderId }, select: { id: true } });
    if (room) {
      const messages = await this.prisma.chatMessage.findMany({ where: { chatRoomId: room.id }, orderBy: { createdAt: 'asc' }, take: 500 });
      if (messages.length) items.push({ kind: 'CHAT_TRANSCRIPT', label: 'In-app chat transcript', content: messages });
    }
    return items;
  }

  private async captureLivenessHistory(userId: string): Promise<CapturedItem[]> {
    const checks = await this.prisma.livenessCheck.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return checks.length ? [{ kind: 'LIVENESS_CHECKS', label: 'Liveness checks (30 days)', content: checks }] : [];
  }

  // ── Sealing (§9.2) ───────────────────────────────────────────────────────

  /** Seal = stamp every item + compute the bundle sealHash over the sorted
   *  item hashes. One transaction; after commit the Postgres triggers make
   *  the content physically immutable. */
  async seal(bundleId: string, opsUserId: string, reason: string): Promise<EvidenceBundle> {
    const bundle = await this.prisma.evidenceBundle.findUnique({ where: { id: bundleId }, include: { items: { select: { id: true, contentHash: true } } } });
    if (!bundle) throw new NotFoundError('EvidenceBundle', bundleId);
    if (bundle.sealedAt) return bundle; // sealing is idempotent
    const now = new Date();
    const sealHash = sha256(bundle.items.map((i) => i.contentHash).sort().join('\n'));
    const [sealed] = await this.prisma.$transaction([
      this.prisma.evidenceBundle.update({ where: { id: bundleId }, data: { sealedAt: now, sealedBy: opsUserId, sealHash } }),
      this.prisma.evidenceItem.updateMany({ where: { bundleId, sealedAt: null }, data: { sealedAt: now } }),
      this.prisma.safetyAccessLog.create({ data: { bundleId, accessorUserId: opsUserId, action: 'SEAL', reason } }),
    ]);
    log().warn({ bundleId, bundleNumber: bundle.bundleNumber, sealHash, opsUserId }, 'evidence bundle SEALED — content is now immutable');
    return sealed;
  }

  /** Sealed content is never viewable without a logged reason (§9.2). The
   *  log write comes FIRST — no log row, no content. */
  async view(bundleId: string, opsUserId: string, reason: string) {
    if (!reason || reason.trim().length < 5) {
      throw new AppError(400, 'REASON_REQUIRED', 'State why you are opening this evidence — the reason is part of the chain of custody.');
    }
    const bundle = await this.prisma.evidenceBundle.findUnique({ where: { id: bundleId }, include: { items: true } });
    if (!bundle) throw new NotFoundError('EvidenceBundle', bundleId);
    await this.prisma.safetyAccessLog.create({ data: { bundleId, accessorUserId: opsUserId, action: 'VIEW', reason: reason.trim() } });
    return bundle;
  }

  /** Legal hold (§9.2/§8.2): also flipped automatically when a linked case
   *  escalates to police. Never auto-cleared. */
  async setLegalHold(bundleId: string, opsUserId: string, reason: string): Promise<EvidenceBundle> {
    const bundle = await this.prisma.evidenceBundle.findUnique({ where: { id: bundleId } });
    if (!bundle) throw new NotFoundError('EvidenceBundle', bundleId);
    if (bundle.legalHold) return bundle;
    const updated = await this.prisma.evidenceBundle.update({ where: { id: bundleId }, data: { legalHold: true } });
    await this.prisma.safetyAccessLog.create({ data: { bundleId, accessorUserId: opsUserId, action: 'LEGAL_HOLD', reason } });
    return updated;
  }

  // ── Live location trail (§9.1, post-trigger) ─────────────────────────────

  /** Rides the 10s SOS tick: every OPEN alert (ACTIVE/ACKNOWLEDGED) with a
   *  ride and an UNSEALED bundle gets the mover's newest fix appended as a
   *  LOCATION_FIX item — the live trail the war room replays later. Dedup on
   *  the fix timestamp; bounded per bundle; a sealed bundle refuses at the DB
   *  and is skipped. (The PRE-trigger trail would need a location ring buffer
   *  the platform doesn't keep — deferred, documented.) */
  async appendLiveFixes(now = new Date()): Promise<{ appended: number }> {
    const open = await this.prisma.sosAlert.findMany({
      where: { status: { in: ['ACTIVE', 'ACKNOWLEDGED'] }, orderId: { not: null } },
      select: { id: true, orderId: true },
      take: 100,
    });
    let appended = 0;
    for (const alert of open) {
      try {
        const bundle = await this.prisma.evidenceBundle.findUnique({
          where: { sosAlertId: alert.id },
          select: { id: true, sealedAt: true },
        });
        if (!bundle || bundle.sealedAt) continue;
        const order = await this.prisma.order.findUnique({
          where: { id: alert.orderId! },
          select: {
            driver: { select: { currentLat: true, currentLng: true, lastLocationUpdate: true } },
            rider: { select: { currentLat: true, currentLng: true, lastLocationUpdate: true } },
          },
        });
        const mover = order?.driver ?? order?.rider;
        if (!mover?.lastLocationUpdate || mover.currentLat == null || mover.currentLng == null) continue;

        const last = await this.prisma.evidenceItem.findFirst({
          where: { bundleId: bundle.id, kind: 'LOCATION_FIX' },
          orderBy: { createdAt: 'desc' },
          select: { content: true },
        });
        const lastAt = (last?.content as { at?: string } | null)?.at;
        if (lastAt && new Date(lastAt).getTime() >= mover.lastLocationUpdate.getTime()) continue; // no new fix
        const count = await this.prisma.evidenceItem.count({ where: { bundleId: bundle.id, kind: 'LOCATION_FIX' } });
        if (count >= 720) continue; // ~2h at the fastest fix cadence — the trail is bounded

        const content = { lat: mover.currentLat, lng: mover.currentLng, at: mover.lastLocationUpdate.toISOString() };
        const canonical = canonicalJson(content);
        await this.prisma.evidenceItem.create({
          data: { bundleId: bundle.id, kind: 'LOCATION_FIX', label: `Live fix ${content.at}`, content: content as never, contentHash: sha256(canonical) },
        });
        appended += 1;
      } catch (err) {
        log().error({ err, sosAlertId: alert.id }, 'evidence live-fix append failed — continuing');
      }
    }
    if (appended > 0) log().info({ appended, at: now.toISOString() }, 'evidence live fixes appended');
    return { appended };
  }

  // ── Export (§9.2) ────────────────────────────────────────────────────────

  /** Server-side encrypted export for police referral: the canonical bundle
   *  (meta + items + sealHash) WATERMARKED with the exporter and timestamp,
   *  encrypted AES-256-GCM under a ONE-TIME passphrase returned exactly once
   *  in the response (never stored — hand it over on a separate channel).
   *  The export itself is chain-of-custody: reason required, EXPORT logged. */
  async export(bundleId: string, opsUserId: string, reason: string) {
    if (!reason || reason.trim().length < 5) {
      throw new AppError(400, 'REASON_REQUIRED', 'State why you are exporting this evidence — the reason is part of the chain of custody.');
    }
    const bundle = await this.prisma.evidenceBundle.findUnique({ where: { id: bundleId }, include: { items: true } });
    if (!bundle) throw new NotFoundError('EvidenceBundle', bundleId);

    const exportedAt = new Date().toISOString();
    const payload = {
      watermark: { exportedBy: opsUserId, exportedAt, bundleNumber: bundle.bundleNumber, notice: 'Swift safety evidence export — access is audited; distribution is restricted.' },
      bundle: {
        bundleNumber: bundle.bundleNumber,
        sosAlertId: bundle.sosAlertId,
        caseId: bundle.caseId,
        subjectUserId: bundle.subjectUserId,
        openedAt: bundle.openedAt,
        sealedAt: bundle.sealedAt,
        sealHash: bundle.sealHash,
        legalHold: bundle.legalHold,
      },
      items: bundle.items.map((i) => ({ kind: i.kind, label: i.label, content: i.content, contentHash: i.contentHash, createdAt: i.createdAt })),
    };

    const passphrase = randomBytes(24).toString('base64url'); // one-time; never persisted
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(canonicalJson(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    await this.prisma.safetyAccessLog.create({ data: { bundleId, accessorUserId: opsUserId, action: 'EXPORT', reason: reason.trim() } });
    log().warn({ bundleId, bundleNumber: bundle.bundleNumber, opsUserId }, 'evidence bundle EXPORTED (encrypted, watermarked)');

    return {
      filename: `${bundle.bundleNumber}-evidence.enc.json`,
      algorithm: 'aes-256-gcm+scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      /** Returned ONCE — hand it over on a separate channel; Swift keeps no copy. */
      passphrase,
    };
  }

  // ── Retention (§9.4) ─────────────────────────────────────────────────────

  /** Nightly: an UNSEALED bundle that never grew a case, whose SOS is closed
   *  (or absent), older than the window → deleted. Sealed bundles and legal
   *  holds are never touched (the DB triggers would refuse anyway — the
   *  service filter and the trigger agree by construction). */
  async retentionSweep(now = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - unattachedRetentionDays() * 86_400_000);
    const candidates = await this.prisma.evidenceBundle.findMany({
      where: { sealedAt: null, legalHold: false, caseId: null, openedAt: { lt: cutoff } },
      select: { id: true, sosAlertId: true },
      take: 200,
    });
    let deleted = 0;
    for (const b of candidates) {
      if (b.sosAlertId) {
        const alert = await this.prisma.sosAlert.findUnique({ where: { id: b.sosAlertId }, select: { status: true } });
        if (alert && alert.status !== 'RESOLVED' && alert.status !== 'CANCELLED') continue; // still live — keep
      }
      try {
        await this.prisma.evidenceBundle.delete({ where: { id: b.id } }); // items cascade
        deleted += 1;
      } catch (err) {
        log().error({ err, bundleId: b.id }, 'evidence retention: delete refused — skipping');
      }
    }
    if (deleted > 0) log().info({ deleted }, 'evidence retention sweep');
    return { deleted };
  }
}
