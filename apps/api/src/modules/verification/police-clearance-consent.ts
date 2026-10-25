import type { Prisma, PrismaClient } from '@prisma/client';
import { publishLegalDocumentOnce, recordConsent, currentConsentDetailed, type ConsentSurface } from '../legal/consent.service';
import { consentSubjectForRole } from './upload-consent';
import {
  configuredDays, DEFAULT_PERSONAL_IMAGE_DAYS, DEFAULT_REJECTED_DOCUMENT_DAYS, PERSONAL_IMAGE_DAYS_KEY, REJECTED_DOCUMENT_DAYS_KEY,
} from './retention-rules';

/**
 * [POLICE-CLEARANCE CONSENT · owner 25 Oct 2026 · DPA s.2 + s.9(1)(a), legal research D1/D2, Privacy s.3]
 *
 * A police clearance is a criminal record — sensitive data — and the Privacy Policy says it rests on the person's
 * explicit consent. So it is uploaded with its OWN tick, in words that say what is true about it:
 *  - what Swift records: whether it was clear and the date it was issued (the reviewer types the issue date; the
 *    clearance is re-checked a year after it);
 *  - when the image goes: the R24 sweeps delete an approved clearance's image `documents.personal_image_days` after
 *    the decision and a rejected one `documents.rejected_document_days` after it, once a day — so the words promise
 *    the longer window plus the day the daily sweep may take, read from the settings when the words are shown;
 *  - that the person can withdraw it at any time (withdrawPoliceClearance below), and what a withdrawal does;
 *  - that a legal duty (a legal hold) can keep more.
 * A taxi driver's clearance is optional. A home-visit provider's is needed for home visits, and the words say why.
 * The words are their own versioned document in the consent ledger (police_clearance_consent); a version names its
 * days, so different days are different words and never re-use a version.
 */

export const POLICE_CLEARANCE_TICK = 'police_clearance_v1' as const;
export const POLICE_CLEARANCE_CONSENT_TYPE = 'police_clearance_consent' as const;
/** The note a withdrawn clearance keeps (the checklist leaves it out; the receipt and the ledger say the rest). */
export const POLICE_CLEARANCE_WITHDRAWN_NOTE = 'WITHDRAWN: by the person';

export type PoliceClearanceKind = 'taxi' | 'home';

/** A mover's clearance is the taxi driver's optional one; a service business or tradesperson's is for home visits. */
export function policeClearanceKind(role: string): PoliceClearanceKind | null {
  if (role === 'MOVER') return 'taxi';
  if (role === 'SERVICE' || role === 'SERVICE_PROVIDER') return 'home';
  return null;
}

type SettingsDb = Pick<PrismaClient, 'platformConfig'> | Prisma.TransactionClient;

/** The longer of the two windows that delete a clearance's image, in days (a setting the sweeps ignore is not promised). */
export async function policeClearanceImageDays(db: SettingsDb): Promise<number> {
  const [approved, rejected] = await Promise.all([
    configuredDays(db as never, PERSONAL_IMAGE_DAYS_KEY, DEFAULT_PERSONAL_IMAGE_DAYS),
    configuredDays(db as never, REJECTED_DOCUMENT_DAYS_KEY, DEFAULT_REJECTED_DOCUMENT_DAYS),
  ]);
  return Math.max(approved, rejected);
}

function wordsFor(kind: PoliceClearanceKind, days: number): string {
  // The sweep runs once a day: an image due after `days` days goes within one more.
  const within = days + 1;
  const record = 'A person at Swift checks it and records only whether it was clear and the date it was issued.';
  const image = `Swift deletes the image within ${within} days of that check.`;
  const law = 'Swift keeps more only where the law requires.';
  return kind === 'taxi'
    ? `Optional. I choose to upload my police clearance. ${record} ${image} I can withdraw it at any time; Swift then deletes it and keeps only a note that it was withdrawn. ${law}`
    : `Needed because I will visit customers' homes. I choose to upload my police clearance. ${record} ${image} I can withdraw it at any time; Swift then deletes it, keeps only a note that it was withdrawn, and pauses my home visits until a new one is approved. ${law}`;
}

function withdrawConfirmFor(kind: PoliceClearanceKind): string {
  return kind === 'taxi'
    ? 'Swift deletes your police clearance now and keeps only a note that it was withdrawn. Your account is no longer recorded as police-cleared.'
    : 'Swift deletes your police clearance now and keeps only a note that it was withdrawn. Your home visits pause until a new one is approved.';
}

export type PoliceClearanceConsent = {
  tick: typeof POLICE_CLEARANCE_TICK;
  kind: PoliceClearanceKind;
  /** The words' version: names the kind and the days it promises. */
  version: string;
  text: string;
  /** What the app says before a withdrawal. */
  withdrawConfirm: string;
};

/** The words this checklist shows now, or null for a checklist with no police clearance. */
export async function policeClearanceConsentFor(db: SettingsDb, role: string): Promise<PoliceClearanceConsent | null> {
  const kind = policeClearanceKind(role);
  if (!kind) return null;
  const days = await policeClearanceImageDays(db);
  return { tick: POLICE_CLEARANCE_TICK, kind, version: `${kind}-v1-${days}d`, text: wordsFor(kind, days), withdrawConfirm: withdrawConfirmFor(kind) };
}

/** Record the person's tick, anchored to the exact words they were shown (the caller checked the version is current). */
export async function recordPoliceClearanceConsent(
  prisma: PrismaClient,
  input: { userId: string; role: string; words: PoliceClearanceConsent; surface: ConsentSurface; ip?: string | null },
): Promise<void> {
  await publishLegalDocumentOnce(prisma, { documentType: POLICE_CLEARANCE_CONSENT_TYPE, version: input.words.version, renderedText: input.words.text });
  await prisma.$transaction((tx) => recordConsent(tx, {
    subjectType: consentSubjectForRole(input.role),
    subjectId: input.userId,
    documentType: POLICE_CLEARANCE_CONSENT_TYPE,
    version: input.words.version,
    action: 'granted',
    surface: input.surface,
    ip: input.ip ?? null,
    evidence: { control: 'police_clearance_checkbox', path: 'verification', docType: 'police_clearance' },
  }));
}

/**
 * The withdrawal, in the ledger: a new row under the version the person last granted (or the current words when
 * their clearance came with the generic document tick, as build 12 sends it).
 */
export async function recordPoliceClearanceWithdrawal(
  prisma: PrismaClient,
  input: { userId: string; role: string; current: PoliceClearanceConsent; surface: ConsentSurface; ip?: string | null; withdrawn: number },
): Promise<void> {
  const subjectType = consentSubjectForRole(input.role);
  const latest = await currentConsentDetailed(prisma, subjectType, input.userId, POLICE_CLEARANCE_CONSENT_TYPE);
  const version = latest?.version ?? input.current.version;
  if (!latest) {
    await publishLegalDocumentOnce(prisma, { documentType: POLICE_CLEARANCE_CONSENT_TYPE, version, renderedText: input.current.text });
  }
  await prisma.$transaction((tx) => recordConsent(tx, {
    subjectType,
    subjectId: input.userId,
    documentType: POLICE_CLEARANCE_CONSENT_TYPE,
    version,
    action: 'withdrawn',
    surface: input.surface,
    ip: input.ip ?? null,
    evidence: { control: 'police_clearance_withdrawn', path: 'verification/police-clearance/withdraw', documents: input.withdrawn },
  }));
}
