// [CHAINS PR2 · owner 29 Oct 2026] The menu copy's key and its result in plain words (components/branch-menu-copy).
// (Split from lib/branches for the page size budget, CI perf #2220.)

/** A key for one menu copy (kept across a retry, so the same copy is never written twice). */
export function newCopyKey(): string {
  const raw = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `copy${raw.replace(/-/g, '')}`.slice(0, 64);
}

/** What a menu copy did, in plain words. */
export function copyResultWords(r: { items: number; categories: number; photos: number; photosNotCopied: number; waitingForCheck: number; notAllowed: Array<{ name: string }> }): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const lines = [`Copied ${n(r.items, 'item', 'items')} in ${n(r.categories, 'section', 'sections')}, with ${n(r.photos, 'photo', 'photos')}.`];
  if (r.photosNotCopied > 0) lines.push(`${n(r.photosNotCopied, 'photo', 'photos')} could not be copied: add ${r.photosNotCopied === 1 ? 'it' : 'them'} again here.`);
  if (r.waitingForCheck > 0) lines.push(`${n(r.waitingForCheck, 'item waits', 'items wait')} for a quick check by Swift before customers see ${r.waitingForCheck === 1 ? 'it' : 'them'}.`);
  if (r.notAllowed.length > 0) lines.push(`Not copied, Swift doesn’t allow: ${r.notAllowed.map((i) => i.name).join(', ')}.`);
  lines.push('Stock counts are per branch: set this branch’s counts here.');
  return lines;
}
