// ---------------------------------------------------------------------------
// [W-42] THE LEGAL DOCUMENT GRAMMAR.
//
// The public legal pages (/legal/terms, /legal/privacy, /legal/child-safety)
// render HTML that is authored in the API (DGP-1), snapshotted into
// `src/legal/generated.ts` at build time and injected with
// `dangerouslySetInnerHTML`. Nothing on that path ever checked the markup: a
// compromised legal endpoint, a poisoned build environment, or one stray
// `onclick` in a source constant would ship a persistent same-origin XSS in a
// release artifact — amplified by a CSP that permits inline script.
//
// This module is the one grammar a legal document may use. It is not a
// "sanitizer" that strips what it dislikes — stripping silently changes the
// document, and the agent writes no legal text. It is a strict parser that
// REJECTS anything outside the grammar and RE-SERIALISES what it accepts, so
// the output is built from the parse tree and never copied from the input:
//   - elements: p h2 h3 ul ol li b strong i em br a — nothing else, and each
//     only where the grammar allows it (blocks at the root, li in a list,
//     inline in a block, never an <a> inside an <a>);
//   - attributes: only href on <a>, and only `mailto:` to an approved domain
//     or `https://` to an approved host — no userinfo, no port, no other
//     scheme; every other attribute (id, name, style, class, on*) is a reject;
//   - no comments, doctypes, processing instructions or CDATA; no control
//     characters; entities from a short named list or numeric, decoded and
//     re-escaped; a bare ampersand or an unknown entity is a reject;
//   - every end tag must close the element that is open; unclosed or stray
//     tags are a reject.
// The same function runs at build (the snapshot is refused if a document
// fails) and at render (a page whose markup is not byte-identical to its own
// canonical form shows plain text instead).
// ---------------------------------------------------------------------------

export const LEGAL_BLOCK_ELEMENTS = ['p', 'h2', 'h3', 'ul', 'ol'] as const;
export const LEGAL_INLINE_ELEMENTS = ['b', 'strong', 'i', 'em', 'br', 'a'] as const;
export const LEGAL_ELEMENTS = [...LEGAL_BLOCK_ELEMENTS, 'li', ...LEGAL_INLINE_ELEMENTS] as const;
/** `mailto:` links may address these domains only. */
export const LEGAL_MAIL_DOMAINS = ['swift.gy'] as const;
/** `https://` links may point at these hosts only — exact host, no subdomain wildcard. */
export const LEGAL_LINK_HOSTS = ['swift.gy', 'www.swift.gy', 'swiftgy.com', 'www.swiftgy.com'] as const;
export const LEGAL_HTML_MAX_CHARS = 256 * 1024;

export interface LegalHtmlOptions {
  mailDomains?: readonly string[];
  linkHosts?: readonly string[];
}
export interface LegalHtmlReject {
  ok: false;
  reason: string;
  /** character offset in the input where the parser stopped */
  at: number;
  /** a short excerpt around `at`, control characters replaced */
  near: string;
}
export interface LegalHtmlAccept {
  ok: true;
  /** the canonical serialisation — the only bytes a page may inject */
  html: string;
}
export type LegalHtmlResult = LegalHtmlAccept | LegalHtmlReject;

type Content = 'blocks' | 'items' | 'inline';
const CONTENT_OF = new Map<string, Content>([
  ['root', 'blocks'],
  ['p', 'inline'],
  ['h2', 'inline'],
  ['h3', 'inline'],
  ['ul', 'items'],
  ['ol', 'items'],
  ['li', 'inline'],
  ['b', 'inline'],
  ['strong', 'inline'],
  ['i', 'inline'],
  ['em', 'inline'],
  ['a', 'inline'],
]);
const BLOCKS = new Set<string>(LEGAL_BLOCK_ELEMENTS);
const INLINE = new Set<string>(LEGAL_INLINE_ELEMENTS);

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['rarr', '→'], ['larr', '←'], ['mdash', '—'], ['ndash', '–'], ['hellip', '…'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['laquo', '«'], ['raquo', '»'],
  ['ldquo', '“'], ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’'], ['bull', '•'],
  ['middot', '·'], ['deg', '°'], ['times', '×'], ['euro', '€'], ['pound', '£'],
]);

// Sticky (`y`) regexes anchor at the current offset — no slicing, no scanning past it.
const START_TAG = /<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)\s*>/y;
const ATTRIBUTE = /\s+([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'=<>`]+)))?/g;
const ENTITY = /&(#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** anything that must never appear inside a link: whitespace, controls, a backslash (host confusion) */
const LINK_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f\\]/;
const MAILTO = /^mailto:([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

function excerpt(input: string, at: number): string {
  return input.slice(Math.max(0, at - 24), at + 48).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

function decodeEntity(body: string): string | null {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp)) return null;
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return null;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return null;
    if (cp >= 0x7f && cp <= 0x9f) return null;
    return String.fromCodePoint(cp);
  }
  return NAMED_ENTITIES.get(body) ?? null; // case-sensitive: &AMP; is not an entity here
}

/** Decode an attribute value: entities resolved, no control characters, no bare ampersand. */
function decodeAttributeValue(raw: string): string | null {
  let out = '';
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i]!;
    if (ch === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(raw);
      if (!m) return null;
      const decoded = decodeEntity(m[1]!);
      if (decoded === null) return null;
      out += decoded;
      i = ENTITY.lastIndex;
      continue;
    }
    if (CONTROL.test(ch)) return null;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The canonical form of a link the grammar admits, or null.
 * `mailto:` — one address at an approved domain, nothing else (no headers).
 * `https://` — an approved host exactly, no userinfo, no port; the URL parser's
 * normalised form is what gets emitted, so a lookalike host (unicode, punycode,
 * a subdomain) never equals an allowlisted one.
 */
export function canonicalLegalLink(raw: string, options: LegalHtmlOptions = {}): string | null {
  if (LINK_FORBIDDEN.test(raw)) return null;
  const mailDomains = new Set((options.mailDomains ?? LEGAL_MAIL_DOMAINS).map((d) => d.toLowerCase()));
  const linkHosts = new Set((options.linkHosts ?? LEGAL_LINK_HOSTS).map((h) => h.toLowerCase()));
  const lower = raw.toLowerCase();
  if (lower.startsWith('mailto:')) {
    const m = MAILTO.exec(raw);
    if (!m) return null;
    const domain = m[2]!.toLowerCase();
    if (!mailDomains.has(domain)) return null;
    return `mailto:${m[1]}@${domain}`;
  }
  if (lower.startsWith('https://')) {
    if (raw.includes('@')) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!linkHosts.has(url.hostname.toLowerCase())) return null;
    return url.href;
  }
  return null;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * Parse `input` under the legal grammar. Accepts → the canonical serialisation
 * (idempotent: parsing the output yields the output). Rejects → the reason and
 * where. Never throws on any string.
 */
export function sanitizeLegalHtml(input: string, options: LegalHtmlOptions = {}): LegalHtmlResult {
  if (typeof input !== 'string') return { ok: false, reason: 'the document is not a string', at: 0, near: '' };
  if (input.length > LEGAL_HTML_MAX_CHARS) {
    return { ok: false, reason: `the document exceeds ${LEGAL_HTML_MAX_CHARS} characters`, at: LEGAL_HTML_MAX_CHARS, near: '' };
  }
  const reject = (reason: string, at: number): LegalHtmlReject => ({ ok: false, reason, at, near: excerpt(input, at) });

  const out: string[] = [];
  const stack: string[] = [];
  const top = (): string => stack[stack.length - 1] ?? 'root';
  let text = '';
  let textStart = 0;

  const flushText = (): LegalHtmlReject | null => {
    if (text === '') return null;
    if (CONTENT_OF.get(top()) !== 'inline') {
      if (text.trim() !== '') return reject(`text is not allowed directly inside <${top()}>`, textStart);
      // whitespace between blocks or list items: one newline (or one space) in canonical form
      out.push(text.includes('\n') ? '\n' : ' ');
    } else {
      out.push(escapeText(text));
    }
    text = '';
    return null;
  };

  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i]!;
    if (ch === '<') {
      const flushed = flushText();
      if (flushed) return flushed;
      if (input.startsWith('</', i)) {
        END_TAG.lastIndex = i;
        const m = END_TAG.exec(input);
        if (!m) return reject('malformed end tag', i);
        const name = m[1]!.toLowerCase();
        if (stack.length === 0) return reject(`stray end tag </${name}>`, i);
        if (top() !== name) return reject(`mismatched end tag </${name}> — <${top()}> is open`, i);
        stack.pop();
        out.push(`</${name}>`);
        i = END_TAG.lastIndex;
        continue;
      }
      if (input.startsWith('<!', i) || input.startsWith('<?', i)) {
        return reject('comments, doctypes, CDATA and processing instructions are not allowed', i);
      }
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(input);
      if (!m) return reject('malformed start tag', i);
      const name = m[1]!.toLowerCase();
      const attrs = m[2]!;
      const selfClosing = m[3] === '/';
      if (name !== 'br' && !CONTENT_OF.has(name)) return reject(`element <${name}> is not allowed`, i);
      if (selfClosing && name !== 'br') return reject(`<${name}/> — only <br> may self-close`, i);

      // placement
      const parent = top();
      const parentContent = CONTENT_OF.get(parent)!;
      if (BLOCKS.has(name)) {
        if (parent !== 'root') return reject(`<${name}> is not allowed inside <${parent}>`, i);
      } else if (name === 'li') {
        if (parentContent !== 'items') return reject('<li> is only allowed inside <ul> or <ol>', i);
      } else if (INLINE.has(name)) {
        if (parentContent !== 'inline') return reject(`<${name}> is not allowed directly inside <${parent}>`, i);
        if (name === 'a' && stack.includes('a')) return reject('<a> may not contain another <a>', i);
      }

      // attributes: none, except exactly one href on <a>
      let href: string | null = null;
      let attrCount = 0;
      ATTRIBUTE.lastIndex = 0;
      for (let a = ATTRIBUTE.exec(attrs); a !== null; a = ATTRIBUTE.exec(attrs)) {
        attrCount += 1;
        const attrName = a[1]!.toLowerCase();
        if (name !== 'a' || attrName !== 'href') return reject(`attribute "${attrName}" is not allowed on <${name}>`, i);
        const rawValue = a[2] ?? a[3] ?? a[4];
        if (rawValue === undefined) return reject('href needs a value', i);
        const decoded = decodeAttributeValue(rawValue);
        if (decoded === null) return reject('href contains a control character or a malformed entity', i);
        const link = canonicalLegalLink(decoded, options);
        if (link === null) return reject('href is not a mailto: to an approved domain or an https:// link to an approved host', i);
        href = link;
      }
      if (name === 'a' && (href === null || attrCount !== 1)) return reject('<a> needs exactly one href', i);

      if (name === 'br') {
        out.push('<br>');
      } else {
        out.push(href === null ? `<${name}>` : `<a href="${escapeAttribute(href)}">`);
        stack.push(name);
      }
      i = START_TAG.lastIndex;
      continue;
    }
    if (ch === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(input);
      if (!m) return reject('bare ampersand or malformed entity — write &amp;', i);
      const decoded = decodeEntity(m[1]!);
      if (decoded === null) return reject(`entity &${m[1]}; is not allowed`, i);
      if (text === '') textStart = i;
      text += decoded;
      i = ENTITY.lastIndex;
      continue;
    }
    if (CONTROL.test(ch)) return reject('control character', i);
    if (text === '') textStart = i;
    text += ch;
    i += 1;
  }
  const flushed = flushText();
  if (flushed) return flushed;
  if (stack.length > 0) return reject(`unclosed <${top()}>`, n);
  return { ok: true, html: out.join('') };
}

/** The words of a document with all markup removed — the render fallback when the markup fails the grammar. */
export function legalPlainText(html: string): string {
  return html
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
