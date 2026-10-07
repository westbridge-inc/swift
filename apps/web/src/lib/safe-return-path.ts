/**
 * [WEB-GUARDS] ONE rule for "send the visitor on to `?next=`".
 *
 * A return path is honoured only when it is an in-app path AS THE BROWSER WILL
 * READ IT. Browsers remove tab, line-feed and carriage-return characters while
 * reading a URL, so "/", a tab, then "/elsewhere" is spelled like a local path
 * but is read as "//elsewhere" — the protocol-relative address of another
 * site. Checking the spelling alone let that through. No control character
 * belongs in an in-app path, so every one is refused; what is left must start
 * with exactly one slash.
 */
export function safeInternalPath(value: string | null | undefined): string | null {
  if (!value) return null;
  // C0 controls and DEL: the browser drops some of these while reading a URL.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('..') || value.includes('\\')) return null;
  return value;
}
