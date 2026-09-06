/**
 * [DOC-1 §10.3/10.5 · P10-4] The activation rehearsal — a report, never a write.
 *
 * Activation is the founder-visible switch: a document type becomes ACTIVE
 * (legal facts verified) and the registry starts to speak for it — the
 * checklist facade answers from requirement sets whose every type is active,
 * the §6.9 routing engages, the category gates already bind. Before any of
 * that, this rehearsal answers the question the grandfather rule asks: would
 * any already-verified actor be suspended? It judges every verified vendor,
 * rider and driver against the checklist they would face after activation,
 * with the SAME evidence rule activation uses, applies the 90-day recheck
 * window (FD-DOC-10: no suspension inside it), and reports the registry gaps
 * that would keep production from booting, the sets that switch source, the
 * routing effects, and the stored-image census. It changes nothing.
 */
import type { PrismaClient } from '@prisma/client';
import type { VerificationService } from './verification.service';
import { CountryConfigService } from '../country/country-config.service';
import { registryCompletenessGaps, BUCKET_OF, REGISTRY_TIER, type RegistryGap } from './doc-registry';
import { resolvesImpl } from './validators';
import { alwaysReview } from './extraction-ledger';

export const GRANDFATHER_DAYS = 90;
const DAY_MS = 86_400_000;

export type ActorKind = 'VENDOR' | 'RIDER' | 'DRIVER';
export type Verdict = 'KEEP' | 'GRANDFATHERED' | 'WOULD_SUSPEND' | 'ALREADY_LAPSED';
export interface ActorVerdict {
  kind: ActorKind;
  actorId: string;
  userId: string;
  role: string;
  checklistToday: string[];
  checklistAfter: string[];
  evidenceValidToday: boolean;
  evidenceValidAfter: boolean;
  verdict: Verdict;
  /** FD-DOC-10: the recheck date carried forward — activation + 90 days. */
  recheckBy: Date;
}
export interface SetSwitch { actorRole: string; registryList: string[]; jsonList: string[]; same: boolean }
export interface RehearsalReport {
  countryCode: string;
  activationDate: Date;
  activating: string[];
  registry: { gaps: RegistryGap[]; setsThatSwitch: SetSwitch[]; moverListsUnaffected: true };
  actors: { total: number; keep: number; grandfathered: number; wouldSuspend: number; alreadyLapsed: number; verdicts: ActorVerdict[] };
  routing: { alwaysReview: string[]; noAutoApprovalUntilConfidence: string[] };
  images: Array<{ bucket: string; stored: number; purged: number }>;
  zeroSuspended: boolean;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function rehearseActivation(
  prisma: PrismaClient,
  service: VerificationService,
  input: { countryCode: string; legacyCodes: readonly string[] | 'ALL'; activationDate?: Date },
): Promise<RehearsalReport> {
  const activationDate = input.activationDate ?? new Date();
  const recheckBy = new Date(activationDate.getTime() + GRANDFATHER_DAYS * DAY_MS);
  const types = await prisma.docType.findMany({ where: { countryCode: input.countryCode } });
  const candidates = types.filter((t) => input.legacyCodes === 'ALL' || input.legacyCodes.includes(t.legacyCode));
  const activeAfter = new Set([...types.filter((t) => t.isActive).map((t) => t.code), ...candidates.map((t) => t.code)]);

  // 1. Would production boot? The completeness gaps as if the candidates were active.
  const gaps = await registryCompletenessGaps(prisma, resolvesImpl, { treatActive: candidates.map((t) => t.code) });

  // 2. Which requirement sets switch from the JSON to the registry, and do they say the same thing?
  const countryConfig = new CountryConfigService(prisma);
  const config = await countryConfig.getByCode(input.countryCode);
  const json = (config.documentChecklists ?? {}) as Record<string, string[]>;
  const sets = await prisma.requirementSet.findMany({
    where: { countryCode: input.countryCode, tier: REGISTRY_TIER, effectiveFrom: { lte: activationDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: activationDate } }] },
    include: { items: { include: { docType: { select: { code: true, legacyCode: true } } }, orderBy: { sortOrder: 'asc' } } },
  });
  const afterList = new Map<string, string[]>();
  const setsThatSwitch: SetSwitch[] = [];
  for (const set of sets) {
    if (set.items.length === 0 || !set.items.every((i) => activeAfter.has(i.docType.code))) continue;
    const registryList = set.items.map((i) => i.docType.legacyCode);
    const jsonList = json[set.actorRole] ?? [];
    afterList.set(set.actorRole, registryList);
    setsThatSwitch.push({ actorRole: set.actorRole, registryList, jsonList, same: same(registryList, jsonList) });
  }

  // 3. Every verified actor, judged with the one evidence rule against today's list and the list after.
  const verdicts: ActorVerdict[] = [];
  const judge = async (kind: ActorKind, actorId: string, userId: string, role: string, today: string[], after: string[]) => {
    const validToday = await service.isVerifiedForList(userId, today);
    const validAfter = await service.isVerifiedForList(userId, after);
    const verdict: Verdict = validAfter ? 'KEEP' : validToday ? 'GRANDFATHERED' : 'ALREADY_LAPSED';
    verdicts.push({ kind, actorId, userId, role, checklistToday: today, checklistAfter: after, evidenceValidToday: validToday, evidenceValidAfter: validAfter, verdict, recheckBy });
  };
  const vendors = await prisma.vendor.findMany({ where: { isVerified: true, owner: { user: { countryCode: input.countryCode } } }, select: { id: true, vendorType: true, owner: { select: { userId: true } } } });
  for (const v of vendors) {
    const today = await countryConfig.getDocumentChecklist(input.countryCode, v.vendorType);
    await judge('VENDOR', v.id, v.owner.userId, v.vendorType, today, afterList.get(v.vendorType) ?? today);
  }
  // Mover checklists compose vehicle profiles from the JSON and do not consult the registry (facade gap, recorded): activation leaves them as they are.
  const riders = await prisma.rider.findMany({ where: { documentsVerified: true, user: { countryCode: input.countryCode } }, select: { id: true, userId: true, vehicleType: true } });
  for (const r of riders) { const today = await countryConfig.getMoverChecklist(input.countryCode, r.vehicleType); await judge('RIDER', r.id, r.userId, `MOVER:${r.vehicleType}`, today, today); }
  const drivers = await prisma.driver.findMany({ where: { documentsVerified: true, user: { countryCode: input.countryCode } }, select: { id: true, userId: true, vehicleType: true } });
  for (const d of drivers) { const today = await countryConfig.getMoverChecklist(input.countryCode, d.vehicleType); await judge('DRIVER', d.id, d.userId, `MOVER:${d.vehicleType}`, today, today); }

  // 4. Routing after activation: what goes to a human, and what can never auto-approve until an adapter reports confidence.
  const routingAlways = candidates.filter((t) => alwaysReview({ bucket: t.bucket, needsSpecimen: t.needsSpecimen, alwaysReview: t.alwaysReview })).map((t) => t.legacyCode).sort();

  // 5. The stored-image census by bucket (§1.3 / CONFLICT-DOC-2 — report only).
  const docs = await prisma.verificationDocument.findMany({ where: { user: { countryCode: input.countryCode } }, select: { docType: true, purgedAt: true, fileUrl: true } });
  const byBucket = new Map<string, { stored: number; purged: number }>();
  for (const d of docs) {
    const bucket = BUCKET_OF[d.docType] ?? 'PERSONAL';
    const row = byBucket.get(bucket) ?? { stored: 0, purged: 0 };
    if (d.purgedAt) row.purged += 1; else if (d.fileUrl) row.stored += 1;
    byBucket.set(bucket, row);
  }

  const count = (v: Verdict) => verdicts.filter((x) => x.verdict === v).length;
  return {
    countryCode: input.countryCode,
    activationDate,
    activating: candidates.map((t) => t.legacyCode).sort(),
    registry: { gaps, setsThatSwitch, moverListsUnaffected: true },
    actors: { total: verdicts.length, keep: count('KEEP'), grandfathered: count('GRANDFATHERED'), wouldSuspend: count('WOULD_SUSPEND'), alreadyLapsed: count('ALREADY_LAPSED'), verdicts },
    routing: { alwaysReview: routingAlways, noAutoApprovalUntilConfidence: candidates.map((t) => t.legacyCode).sort() },
    images: [...byBucket.entries()].map(([bucket, c]) => ({ bucket, ...c })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
    zeroSuspended: count('WOULD_SUSPEND') === 0,
  };
}

/** The founder-facing summary. */
export function renderRehearsal(r: RehearsalReport): string {
  const lines = [
    `# DOC-1 activation rehearsal — ${r.countryCode} — ${r.activationDate.toISOString().slice(0, 10)}`,
    ``,
    `Activating: ${r.activating.join(', ') || '(nothing)'}`,
    `Grandfather: recheck by ${new Date(r.activationDate.getTime() + GRANDFATHER_DAYS * DAY_MS).toISOString().slice(0, 10)} (FD-DOC-10, ${GRANDFATHER_DAYS} days, no suspension inside the window)`,
    ``,
    `## Verified actors: ${r.actors.total} — keep ${r.actors.keep}, grandfathered ${r.actors.grandfathered}, already lapsed ${r.actors.alreadyLapsed}, WOULD SUSPEND ${r.actors.wouldSuspend}`,
    r.zeroSuspended ? `ZERO actors suspended by this activation.` : `STOP: ${r.actors.wouldSuspend} actor(s) would be suspended — fix before activating.`,
    ...r.actors.verdicts.filter((v) => v.verdict !== 'KEEP').map((v) => `- ${v.kind} ${v.actorId} (${v.role}): ${v.verdict} — today ${v.checklistToday.join('/')} → after ${v.checklistAfter.join('/')}`),
    ``,
    `## Registry gaps (production refuses to boot past these for an active type): ${r.registry.gaps.length}`,
    ...r.registry.gaps.slice(0, 40).map((g) => `- ${g.docTypeCode}: ${g.gap}${g.detail ? ` (${g.detail})` : ''}`),
    ``,
    `## Requirement sets that switch from the JSON to the registry: ${r.registry.setsThatSwitch.length}`,
    ...r.registry.setsThatSwitch.map((s) => `- ${s.actorRole}: ${s.same ? 'same list' : `DIFFERS — registry ${s.registryList.join('/')} vs json ${s.jsonList.join('/')}`}`),
    `- mover checklists compose vehicle profiles from the JSON and do not consult the registry (facade gap, recorded)`,
    ``,
    `## Routing after activation`,
    `- always a human (PERSONAL / needs specimen / by fact): ${r.routing.alwaysReview.join(', ') || '(none)'}`,
    `- no auto-approval until an adapter reports extraction confidence: ${r.routing.noAutoApprovalUntilConfidence.join(', ') || '(none)'}`,
    ``,
    `## Stored images by bucket (§1.3, report only)`,
    ...r.images.map((i) => `- ${i.bucket}: ${i.stored} stored, ${i.purged} purged`),
  ];
  return lines.join('\n');
}
