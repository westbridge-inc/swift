/**
 * Convert either storage-provider spelling into one canonical managed-object
 * key. Database pointers are authority-bearing at deletion and render sinks,
 * so URLs, ambiguous encodings and traversal syntax fail closed.
 */
export function canonicalManagedObjectKey(raw: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  if (raw.includes('\\') || raw.includes('\0') || raw.includes('?') || raw.includes('#') || raw.includes('%')) return null;
  if (raw.startsWith('/') && !raw.startsWith('/uploads/')) return null;

  const key = raw.replace(/^\/?uploads\//, '');
  const segments = key.split('/');
  if (
    segments.length < 3
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) return null;
  return key;
}

export function managedObjectKeyAliases(raw: string): string[] {
  const key = canonicalManagedObjectKey(raw);
  return key ? [key, `uploads/${key}`, `/uploads/${key}`] : [];
}

export function managedObjectKeyIsNamespacedTo(raw: string, root: string, userId: string): boolean {
  const key = canonicalManagedObjectKey(raw);
  if (
    !key || !root || root.includes('/') || root === '.' || root === '..'
    || !userId || userId.includes('/') || userId === '.' || userId === '..'
  ) return false;
  const prefix = `${root}/${userId}/`;
  return key.startsWith(prefix) && key.length > prefix.length;
}
