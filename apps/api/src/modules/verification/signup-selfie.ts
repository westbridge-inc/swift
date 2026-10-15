/**
 * [Item 98] THE SIGNUP SELFIE BESIDE THE ID — compared by a person, never by a machine.
 *
 * Face-matching is deliberately off at launch (owner ruling, row 54), so a
 * reviewer checking an identity document compares the applicant's own signup
 * selfie with the photo on the ID by eye. The selfie travels only inside a
 * granted, audited view of an identity document (admin document-url), and
 * only when the stored pointer is the applicant's own capture: the POST
 * /auth/selfie writer files it under `avatars/<their id>/`. Anything else —
 * someone else's folder, a path that climbs out of it, a photo that was never
 * captured — shows nothing rather than a stand-in face.
 */
import { resolveAvatarUrl } from '../../utils/avatar-url';
import { SELFIE_COMPARE_DOC_TYPES } from './doc-registry';

export interface SignupSelfie { url: string; capturedAt: string }

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Is this stored pointer the applicant's own selfie object (local path or storage key)? */
export function isOwnSelfiePointer(userId: string, avatar: string | null | undefined): boolean {
  if (!avatar) return false;
  const key = avatar.startsWith('/uploads/') ? avatar.slice('/uploads/'.length) : avatar;
  const parts = key.split('/');
  return parts.length === 3 && parts[0] === 'avatars' && parts[1] === userId
    && SAFE_NAME.test(parts[2]!) && !parts[2]!.includes('..');
}

/** The selfie to show beside this document, or null. Only a photo ID carries one (national ID, passport or licence). */
export async function signupSelfieFor(
  docType: string,
  user: { id: string; avatar: string | null; selfieCapturedAt: Date | null } | null,
): Promise<SignupSelfie | null> {
  if (!user || !SELFIE_COMPARE_DOC_TYPES.has(docType)) return null;
  if (!user.selfieCapturedAt || !isOwnSelfiePointer(user.id, user.avatar)) return null;
  const url = await resolveAvatarUrl(user.avatar);
  return url ? { url, capturedAt: user.selfieCapturedAt.toISOString() } : null;
}
