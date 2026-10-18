/**
 * [WEB-GUARDS · row 331 lane 9] ONE rule for "send the visitor on to `?next=`" (sign-in, sign-up, selfie and the
 * storefront return). Continues the reference fix in draft #1468 (7 Oct), rebuilt on current main.
 *
 * A return path is honoured only when it is a same-origin path AS THE BROWSER WILL READ IT:
 * - Browsers drop tab, line feed and carriage return anywhere in a URL, so "/", a tab, "/evil.example" is spelled
 *   like a local path but read as "//evil.example", another site. No control character belongs in an in-app path,
 *   so every C0 control, DEL and C1 control is refused.
 * - It must start with exactly one "/" ("//host" is protocol-relative) and hold no "\" (browsers read it as "/").
 * - The same checks run again on the percent-decoded text (up to three rounds), and the decoded text may not hold
 *   "//" or ".." anywhere, so an encoded slash, backslash or control character cannot slip through a later decode.
 * - Last, the path is resolved against a fixed origin and must stay on it.
 * Anything else returns null; each caller then sends the visitor to its default page.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BASE = 'https://return-path.invalid';

function plainPathProblem(text: string): boolean {
  return CONTROL.test(text) || text.includes('\\') || !text.startsWith('/') || text.startsWith('//');
}

export function safeInternalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (plainPathProblem(value)) return null;
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (plainPathProblem(next) || next.includes('//') || next.includes('..')) return null;
    if (next === decoded) break;
    decoded = next;
  }
  let resolved: URL;
  try { resolved = new URL(value, BASE); } catch { return null; }
  if (resolved.origin !== BASE) return null;
  return value;
}
