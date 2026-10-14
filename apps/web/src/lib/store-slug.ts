/** A store's web address as the server mints it: the name plus a nanoid code
 *  (partner.service.ts — `slugify(name)-${nanoid(6)}`), so capitals, digits,
 *  `-` and `_`. No dots, slashes or anything that could leave /store/<slug>.
 *  The one rule for every website check; the phone app carries the same one
 *  (apps/mobile/src/lib/deepLinkParse.ts STORE_SLUG_RE). */
export const STORE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
