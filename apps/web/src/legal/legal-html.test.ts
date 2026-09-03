import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalLegalLink,
  legalPlainText,
  sanitizeLegalHtml,
  LEGAL_HTML_MAX_CHARS,
} from './legal-html';
import { TERMS_BODY, PRIVACY_BODY, CHILD_SAFETY_BODY } from './generated';

// ---------------------------------------------------------------------------
// [W-42] The legal documents are the one place this app injects raw HTML. The
// grammar is a parser that REJECTS anything outside it and re-serialises what
// it accepts, so a poisoned legal endpoint or build environment cannot put a
// script, an event handler, a foreign link or a control character into a
// release artifact. These tests are the attack surface, not the happy path.
// ---------------------------------------------------------------------------

const accept = (html: string): string => {
  const result = sanitizeLegalHtml(html);
  if (!result.ok) throw new Error(`expected accept, got reject: ${result.reason} near ${result.near}`);
  return result.html;
};
const reject = (html: string): string => {
  const result = sanitizeLegalHtml(html);
  if (result.ok) throw new Error(`expected reject, got accept: ${result.html}`);
  return result.reason;
};

describe('[W-42] the shipped documents are inside the grammar', () => {
  it('every published body is accepted and is already its own canonical form', () => {
    for (const [name, body] of [
      ['TERMS_BODY', TERMS_BODY],
      ['PRIVACY_BODY', PRIVACY_BODY],
      ['CHILD_SAFETY_BODY', CHILD_SAFETY_BODY],
    ] as const) {
      const result = sanitizeLegalHtml(body);
      expect(result.ok, `${name}: ${result.ok ? '' : `${result.reason} near ${result.near}`}`).toBe(true);
      if (!result.ok) continue;
      // byte-identical: the render-time check can compare rather than replace
      expect(result.html, name).toBe(body);
      // idempotent: parsing the canonical form yields the canonical form
      expect(accept(result.html), name).toBe(result.html);
    }
  });

  it('the documents actually exercise the grammar — links, lists and emphasis are present, so this is not a vacuous pass', () => {
    const all = TERMS_BODY + PRIVACY_BODY + CHILD_SAFETY_BODY;
    expect(all).toMatch(/<a href="mailto:/);
    expect(all).toMatch(/<ul><li>|<ul>\s*<li>/);
    expect(all).toMatch(/<b>/);
    expect(all).toMatch(/<h2>/);
    expect(all.length).toBeGreaterThan(20_000);
  });
});

describe('[W-42] script injection', () => {
  it.each([
    ['<script>alert(1)</script>', 'a script element'],
    ['<p>ok</p><script src="https://evil.test/x.js"></script>', 'a remote script'],
    ['<p onclick="steal()">text</p>', 'an inline event handler'],
    ['<p ONMOUSEOVER="steal()">text</p>', 'an uppercase event handler'],
    ['<p onclick=steal()>text</p>', 'an unquoted event handler'],
    ['<img src=x onerror="steal()">', 'an image with onerror'],
    ['<iframe src="https://evil.test"></iframe>', 'a frame'],
    ['<object data="x"></object>', 'an object'],
    ['<embed src="x">', 'an embed'],
    ['<svg><script>alert(1)</script></svg>', 'SVG'],
    ['<math><mtext></mtext></math>', 'MathML'],
    ['<style>body{background:url(javascript:1)}</style>', 'a style element'],
    ['<p style="background:url(javascript:1)">x</p>', 'a style attribute'],
    ['<base href="https://evil.test/">', 'a base tag'],
    ['<meta http-equiv="refresh" content="0;url=https://evil.test">', 'a meta refresh'],
    ['<link rel="stylesheet" href="https://evil.test/x.css">', 'a stylesheet link'],
    ['<form action="https://evil.test"><input name="a"></form>', 'a form'],
    ['<template><p>x</p></template>', 'a template'],
    ['<p><!-- <script>alert(1)</script> --></p>', 'a comment'],
    ['<!DOCTYPE html><p>x</p>', 'a doctype'],
    ['<?php echo 1; ?>', 'a processing instruction'],
    ['<![CDATA[<script>alert(1)</script>]]>', 'CDATA'],
    ['<p>x</p><textarea></textarea>', 'a textarea'],
    ['<noscript><p>x</p></noscript>', 'noscript'],
  ])('rejects %s (%s)', (html) => {
    expect(reject(html)).toBeTruthy();
  });

  it('DOM clobbering handles are refused — id, name and form attributes cannot be smuggled in', () => {
    expect(reject('<p id="body">x</p>')).toContain('id');
    expect(reject('<p><a name="attributes" href="mailto:privacy@swift.gy">x</a></p>')).toContain('name');
    expect(reject('<p class="legal-prose">x</p>')).toContain('class');
    expect(reject('<p data-x="1">x</p>')).toContain('data-x');
    expect(reject('<p><a href="mailto:privacy@swift.gy" target="_blank">x</a></p>')).toContain('target');
  });
});

describe('[W-42] link schemes and hosts', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://swift.gy/insecure',
    '//evil.test/protocol-relative',
    '/relative/path',
    'https://evil.test/',
    'https://swift.gy.evil.test/',
    'https://evil.test/?x=swift.gy',
    'https://swift.gy@evil.test/',
    'https://user:pass@swift.gy/',
    'https://swift.gy:8443/',
    'https://ѕwift.gy/',
    'https://xn--wift-y1a.gy/',
    'mailto:attacker@evil.test',
    'mailto:privacy@swift.gy.evil.test',
    'mailto:privacy@swift.gy?subject=x&body=y',
    'mailto:privacy@swift.gy,attacker@evil.test',
  ])('refuses href %s', (href) => {
    expect(canonicalLegalLink(href)).toBeNull();
    expect(reject(`<p><a href="${href.replace(/"/g, '&quot;')}">x</a></p>`)).toBeTruthy();
  });

  it.each([
    ['mailto:privacy@swift.gy', 'mailto:privacy@swift.gy'],
    ['mailto:childsafety@swift.gy', 'mailto:childsafety@swift.gy'],
    ['mailto:PRIVACY@SWIFT.GY', 'mailto:PRIVACY@swift.gy'],
    ['https://swift.gy/legal/terms', 'https://swift.gy/legal/terms'],
    ['https://www.swiftgy.com/', 'https://www.swiftgy.com/'],
  ])('admits %s', (href, canonical) => {
    expect(canonicalLegalLink(href)).toBe(canonical);
  });

  it('an entity-encoded javascript: URL is decoded before the check, not after', () => {
    // &#106;avascript:  — the classic filter bypass
    expect(reject('<p><a href="&#106;avascript:alert(1)">x</a></p>')).toBeTruthy();
    expect(reject('<p><a href="&#x6a;avascript:alert(1)">x</a></p>')).toBeTruthy();
    expect(reject('<p><a href="java&#0000000115;cript:alert(1)">x</a></p>')).toBeTruthy();
  });

  it('an href is decoded exactly once — an entity-encoded ampersand survives as one ampersand, not two', () => {
    // decode: &amp; → &  ·  re-escape on output: & → &amp;. A link that skipped the
    // decode would emit &amp;amp; and send the reader to a different query.
    expect(accept('<p><a href="https://swift.gy/legal?a=1&amp;b=2">x</a></p>')).toBe(
      '<p><a href="https://swift.gy/legal?a=1&amp;b=2">x</a></p>',
    );
    expect(canonicalLegalLink('https://swift.gy/legal?a=1&b=2')).toBe('https://swift.gy/legal?a=1&b=2');
  });

  it('a link is emitted from the parsed URL, not copied from the input', () => {
    // the input spells the host in mixed case with a default port stripped by the URL parser
    expect(accept('<p><a href="https://SWIFT.gy/legal">x</a></p>')).toBe('<p><a href="https://swift.gy/legal">x</a></p>');
  });

  it('an <a> may not nest inside another <a>', () => {
    expect(reject('<p><a href="mailto:privacy@swift.gy"><a href="mailto:privacy@swift.gy">x</a></a></p>')).toContain('<a>');
  });

  it('an <a> needs exactly one href', () => {
    expect(reject('<p><a>x</a></p>')).toContain('href');
    expect(reject('<p><a href>x</a></p>')).toBeTruthy();
    expect(reject('<p><a href="mailto:privacy@swift.gy" href="mailto:x@swift.gy">x</a></p>')).toBeTruthy();
  });
});

describe('[W-42] malformed markup is a reject, never a guess', () => {
  it.each([
    ['<p>unclosed', 'unclosed'],
    ['<p>x</div>', 'mismatched'],
    ['</p>', 'stray'],
    ['<p><b>x</p></b>', 'mismatched'],
    ['<ul><p>x</p></ul>', 'not allowed'],
    ['<li>orphan</li>', 'only allowed inside'],
    ['<p><p>nested block</p></p>', 'not allowed'],
    ['<b>inline at the root</b>', 'not allowed'],
    ['bare text at the root', 'not allowed'],
    ['<p/>', 'self-close'],
    ['<p <b>x</b></p>', 'malformed'],
    ['<p>a < b</p>', 'malformed'],
    ['<p>Tom & Jerry</p>', 'ampersand'],
    ['<p>&unknownentity;</p>', 'not allowed'],
    ['<p>&#0;</p>', 'not allowed'],
    ['<p>&#xD800;</p>', 'not allowed'],
  ])('rejects %s', (html, reason) => {
    expect(reject(html)).toContain(reason);
  });

  it('rejects control characters, including a NUL inside an attribute', () => {
    expect(reject('<p>a\u0000b</p>')).toContain('control');
    expect(reject('<p>a\u0008b</p>')).toContain('control');
    expect(reject('<p><a href="mailto:privacy@swift.gy\u0000">x</a></p>')).toBeTruthy();
    // a newline and a tab are ordinary whitespace, not control characters
    expect(accept('<p>a\n\tb</p>')).toBe('<p>a\n\tb</p>');
  });

  it('refuses a document larger than the cap without scanning it', () => {
    const huge = `<p>${'a'.repeat(LEGAL_HTML_MAX_CHARS)}</p>`;
    const result = sanitizeLegalHtml(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('exceeds');
  });

  it('never throws, whatever the input', () => {
    for (const input of ['', '<', '>', '&', '</', '<>', '<a', '\u0000', '<p>'.repeat(5000), '&'.repeat(1000)]) {
      expect(() => sanitizeLegalHtml(input)).not.toThrow();
    }
    expect(sanitizeLegalHtml('').ok).toBe(true);
  });
});

describe('[W-42] the output is built from the parse tree', () => {
  it('text is re-escaped, so a decoded entity cannot reopen a tag', () => {
    expect(accept('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(accept('<p>a &amp; b</p>')).toBe('<p>a &amp; b</p>');
    // &#38; decodes to & and must come back out as &amp;, not as a bare ampersand
    expect(accept('<p>a &#38; b</p>')).toBe('<p>a &amp; b</p>');
  });

  it('tag names are lowercased and attribute order cannot survive, because nothing is copied', () => {
    expect(accept('<P>x</P>')).toBe('<p>x</p>');
    expect(accept('<P><B>x</B></P>')).toBe('<p><b>x</b></p>');
  });

  it('accepts the elements the documents use and nothing more', () => {
    expect(accept('<h2>H</h2><p><b>b</b><strong>s</strong><i>i</i><em>e</em><br>t</p><ul><li>x</li></ul><ol><li>y</li></ol><h3>h3</h3>')).toBe(
      '<h2>H</h2><p><b>b</b><strong>s</strong><i>i</i><em>e</em><br>t</p><ul><li>x</li></ul><ol><li>y</li></ol><h3>h3</h3>',
    );
    expect(reject('<h1>too high</h1>')).toContain('not allowed');
    expect(reject('<div>x</div>')).toContain('not allowed');
    expect(reject('<span>x</span>')).toContain('not allowed');
    expect(reject('<table><tr><td>x</td></tr></table>')).toContain('not allowed');
  });
});

describe('[W-42] the plain-text fallback carries the words and no markup', () => {
  it('strips every tag and decodes the entities the grammar admits', () => {
    const text = legalPlainText('<h2>Title</h2><p>a &amp; b <b>bold</b></p>');
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Title');
    expect(text).toContain('a & b bold');
  });

  it('an unparseable document still yields readable words, not markup', () => {
    const text = legalPlainText('<p onclick="x">The fee is 5%</p><script>alert(1)</script>');
    expect(text).not.toContain('onclick');
    expect(text).not.toContain('<');
    expect(text).toContain('The fee is 5%');
  });
});

describe('[W-42] the pipeline enforces the grammar at build and at render', () => {
  const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

  it('sync-legal refuses to write a snapshot whose markup is outside the grammar', () => {
    const script = source('scripts/sync-legal.ts');
    expect(script).toContain("from '../src/legal/legal-html'");
    expect(script).toMatch(/sanitizeLegalHtml\(/);
    // it must throw, not silently sanitize: the agent writes no legal text
    expect(script).toMatch(/throw new Error\(/);
  });

  it('the renderer injects only markup it has re-parsed, and falls back to plain text otherwise', () => {
    const component = source('src/components/legal-document.tsx');
    expect(component).toContain("from '@/legal/legal-html'");
    expect(component).toMatch(/sanitizeLegalHtml\(/);
    expect(component).toMatch(/legalPlainText\(/);
    // the raw prop must never reach dangerouslySetInnerHTML
    expect(component).not.toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*html\s*\}\}/);
  });

  it('the production CSP grants no unsafe-eval to the public site, and development still gets it for HMR', async () => {
    const { buildBrowserContentSecurityPolicy } = await import('@/lib/browser-api-origin');
    const production = buildBrowserContentSecurityPolicy('production');
    expect(production).not.toContain('unsafe-eval');
    expect(production).toContain("script-src 'self' 'unsafe-inline'");
    expect(production).toContain("object-src 'none'");
    expect(production).toContain("base-uri 'self'");
    expect(buildBrowserContentSecurityPolicy('development')).toContain("'unsafe-eval'");
  });
});
