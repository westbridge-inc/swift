/**
 * [item 20 · owner wall · REVIEW-M S4-3] The owner-wall censuses read the
 * source as text and count `.<delegate>.<op>(` — every call through a Prisma
 * delegate written the usual way. A delegate reached any other way escapes
 * them, so these list every such access for a census to pin:
 *  - taken as a value: `const n = tx.notification` (no call after it);
 *  - by a quoted name: `tx['notification']`;
 *  - as an object key or destructured: `const { notification } = tx`,
 *    `({ notification }) => ...`, `{ notification: n } = db`;
 *  - and any client indexed by a computed name (`prisma[model]`, `tx[name]`),
 *    which no regex can follow.
 * One entry per access (its form, in source order); a census counts them per
 * file and expects none, or pins the known ones (line numbers would churn).
 */

export function delegateEscapes(text: string, delegate: string): string[] {
  const found: Array<[number, string]> = [];
  const add = (re: RegExp, form: string) => { for (const m of text.matchAll(re)) found.push([m.index!, form]); };
  // No line break after the dot: a sentence's full stop before a word is not a member access.
  add(new RegExp(`\\.[ \\t]*${delegate}\\b(?!\\s*\\.\\s*\\w+\\s*\\()`, 'g'), `.${delegate} without a call`);
  add(new RegExp(`\\[\\s*(['"\`])${delegate}\\1\\s*\\]`, 'g'), `['${delegate}']`);
  add(new RegExp(`[{,]\\s*${delegate}\\s*[,}:]`, 'g'), `{ ${delegate} } key or destructuring`);
  return found.sort((a, b) => a[0] - b[0]).map(([, form]) => form);
}

export function computedClientAccess(text: string): string[] {
  return [...text.matchAll(/\b(prisma|tenantPrisma|tx|db|client)\[/g)].map((m) => `${m[1]}[...]`);
}
