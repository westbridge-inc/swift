/**
 * [Legal research A10 · R1 · owner 15 Oct 2026] Courier = goods only. In Guyana the Post Office holds the
 * exclusive privilege of carrying letters (Post and Telegraph Act, Cap. 47:01), and the research says to exclude
 * letters, documents and mail until the Post Office authorises Swift. So a parcel described as any of them is
 * refused in plain words before anything is written — documents travelling with goods included (the owner's
 * ruling follows the research: no document exception). The sender's tick ("This parcel has no prohibited
 * items") names them too.
 */
const POSTAL_WORDS = /\b(letters?|documents?|docs|mail|mailing|envelopes?|correspondence|postcards?|cheques?|parcel post)\b/i;

/** The postal word a description names, or null. */
export function postalItem(description: string | null | undefined): string | null {
  if (!description) return null;
  const hit = POSTAL_WORDS.exec(description.normalize('NFKC').replace(/[​-‍﻿]/g, ''));
  return hit ? hit[1]!.toLowerCase() : null;
}

/** What the sender is told. */
export const POSTAL_REFUSAL = "Swift can't carry letters, documents or mail: in Guyana only the Post Office may carry them. Swift's couriers carry goods only.";
