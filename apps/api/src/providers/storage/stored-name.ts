/**
 * The name of a stored object inside its own folder: what createOpaqueStorageName issues, or an older upload's plain
 * name. The writer draws from nanoid's alphabet, so `-` and `_` are ordinary first characters, 2 names in 64.
 *
 * It is one path segment and nothing else: letters, digits, `.`, `_` and `-`, never a leading dot, never `..`, so no
 * name can leave its folder. The caller still splits the path and checks the folder and the owner itself.
 */
const STORED_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function isStoredName(name: string): boolean {
  return STORED_NAME.test(name) && !name.includes('..');
}
