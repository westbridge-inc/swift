import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C8] On a 360px phone, nothing in a row is cut off.
//
// The customer pages have a 24px side gutter (.sw-page), so a 360px phone
// leaves 312px of content, and html / .swift-app use overflow-x: clip: what
// does not fit is CUT OFF, never scrollable. On the store's Rider fees owed
// row, the "Hand X $Y? / Yes, handed over / Cancel" group refused to shrink
// and was cut off, so the store could not confirm a cash handover (U03). On
// the order page, the no-wrap status pill squeezed the title until it
// overlapped (U15).
// This census reads every web .tsx with the TypeScript parser, with its
// Tailwind classes and its CSS-module rules (`import styles from
// './x.module.css'`, className={styles.a} / template / cx(…)):
// a ROW is a flex row (Tailwind `flex`/`inline-flex`, or CSS display:flex)
// that does not wrap at 360px: no base `flex-wrap`/`flex-col`/`grid`, and no
// flex-wrap / column / grid rule for it in the base CSS or a max-width media
// query (an `sm:` class or a min-width query does nothing at 360px). In it,
// through {cond && …} / ternaries / fragments, a direct child is cut off when:
//   R1 it refuses to shrink (shrink-0 / flex-none / whitespace-nowrap, or
//      flex: none / flex-shrink: 0 / white-space: nowrap) and holds two or
//      more controls (button / a / Link / input / select), and does not wrap
//      itself (U03);
//   R2 it is no-wrap text (whitespace-nowrap / white-space: nowrap) showing
//      a value ({…}) with no ellipsis (truncate / text-overflow: ellipsis)
//      (U15).
// happy-dom has no layout, so this reads structure; check a fix in a browser
// at 360px too. A new hit fails the suite; fix it, or list it with the reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const GLOBALS = 'app/globals.css';

interface Hit { file: string; line: number; text: string }
interface Rule { base: Record<string, string>; narrow: Record<string, string> }
interface Census { hits: Hit[]; rows: number; files: number }

/** A CSS module: class -> declarations of plain `.x` rules (base, and inside a max-width media query). */
function parseCss(text: string): Map<string, Rule> {
  const out = new Map<string, Rule>();
  const add = (cls: string, kind: keyof Rule, decls: Record<string, string>) => {
    if (!out.has(cls)) out.set(cls, { base: {}, narrow: {} });
    Object.assign(out.get(cls)![kind], decls);
  };
  const walk = (s: string, media: 'none' | 'narrow' | 'wide') => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const sel = s.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < s.length && depth; j++) depth += s[j] === '{' ? 1 : s[j] === '}' ? -1 : 0;
      const body = s.slice(open + 1, j - 1);
      if (sel.startsWith('@media')) walk(body, media === 'wide' || !/max-width/.test(sel) ? 'wide' : 'narrow');
      else if (sel.startsWith('@')) walk(body, media);
      else if (media !== 'wide') {
        const decls = Object.fromEntries(body.split(';').map((d) => d.split(':').map((x) => x.trim())).filter((d) => d.length >= 2 && !!d[0]).map(([k, ...v]) => [k!, v.join(':')]));
        for (const part of sel.split(',')) {
          const m = /^\.([A-Za-z_][\w-]*)$/.exec(part.trim());
          if (m) add(m[1]!, media === 'none' ? 'base' : 'narrow', decls);
        }
      }
      i = j;
    }
  };
  walk(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[\w-]+[^;{}]*;/g, ''), 'none');
  return out;
}

interface Style { tw: string[]; all: string[]; css: Rule[] }
/** A control: button / a / input / select, or any component named …Button / …Link (<PillButton/>, <Nav.Link/>). */
const CONTROL = /^(button|a|input|select|[\w.]*(Button|Link))$/;

function census(files: Record<string, string>): Census {
  const out: Census = { hits: [], rows: 0, files: 0 };
  const cssCache = new Map<string, Map<string, Rule>>();
  // [#1960 review S3-1] The design system's global classes (.sw-row, .sw-status, .sw-chip …) are
  // plain `.x` rules in app/globals.css: a bare class token is looked up there too.
  const globals = files[GLOBALS] !== undefined ? parseCss(files[GLOBALS]!) : new Map<string, Rule>();
  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith('.tsx')) continue;
    out.files++;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const modules = new Map<string, Map<string, Rule>>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause?.name || !ts.isStringLiteral(st.moduleSpecifier) || !/\.module\.css$/.test(st.moduleSpecifier.text)) continue;
      const path = relative('/', resolve('/', dirname(file), st.moduleSpecifier.text));
      if (files[path] === undefined) continue;
      if (!cssCache.has(path)) cssCache.set(path, parseCss(files[path]!));
      modules.set(st.importClause.name.text, cssCache.get(path)!);
    }
    // [#1960 review S4-2] className={row}: a const in this file whose value is a class string
    // (or a ternary / join / module class of them) is read as if written in place.
    const consts = new Map<string, ts.Expression>();
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !consts.has(n.name.text)
        && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer) || ts.isTemplateExpression(n.initializer)
          || ts.isConditionalExpression(n.initializer) || ts.isBinaryExpression(n.initializer) || ts.isParenthesizedExpression(n.initializer)
          || (ts.isPropertyAccessExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && modules.has(n.initializer.expression.text)))) {
        consts.set(n.name.text, n.initializer);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const opening = (el: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(el) ? el.openingElement : el);
    const tag = (el: ts.JsxElement | ts.JsxSelfClosingElement) => opening(el).tagName.getText();
    const attr = (el: ts.JsxElement | ts.JsxSelfClosingElement, name: string) => opening(el).attributes.properties
      .find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
    const classAttr = (el: ts.JsxElement | ts.JsxSelfClosingElement) => attr(el, 'className');
    /** [#1960 review S4-2] style={{ display: 'flex', whiteSpace: 'nowrap' }} as a base CSS rule. */
    const inlineStyle = (el: ts.JsxElement | ts.JsxSelfClosingElement): Rule | null => {
      const init = attr(el, 'style')?.initializer;
      const obj = init && ts.isJsxExpression(init) ? init.expression : undefined;
      if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
      const base: Record<string, string> = {};
      for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
        const v = p.initializer;
        if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || ts.isNumericLiteral(v)) {
          base[p.name.text.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = v.text;
        }
      }
      return { base, narrow: {} };
    };
    const style = (el: ts.JsxElement | ts.JsxSelfClosingElement): Style => {
      const s: Style = { tw: [], all: [], css: [] };
      const inline = inlineStyle(el);
      if (inline) s.css.push(inline);
      const init = classAttr(el)?.initializer;
      if (!init) return s;
      const seen = new Set<string>();
      const visit = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
          for (const t of n.text.split(/\s+/).filter(Boolean)) {
            s.all.push(t);
            if (!t.includes(':')) { s.tw.push(t); const g = globals.get(t); if (g) s.css.push(g); }
          }
        }
        if (ts.isIdentifier(n) && consts.has(n.text) && !seen.has(n.text)
          && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) { seen.add(n.text); visit(consts.get(n.text)!); }
        const mod = (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(n.expression) ? modules.get(n.expression.text) : undefined;
        if (mod && ts.isPropertyAccessExpression(n)) { const r = mod.get(n.name.text); if (r) s.css.push(r); }
        if (mod && ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) { const r = mod.get(n.argumentExpression.text); if (r) s.css.push(r); }
        ts.forEachChild(n, visit);
      };
      visit(init);
      return s;
    };
    const decl = (s: Style, kinds: Array<keyof Rule>, prop: string, re: RegExp) => s.css.some((r) => kinds.some((k) => r[k][prop] !== undefined && re.test(r[k][prop]!)));
    const isRow = (s: Style) => (s.tw.includes('flex') || s.tw.includes('inline-flex') || decl(s, ['base'], 'display', /^(inline-)?flex$/));
    /** Wraps (or is not a row) at 360px: base Tailwind classes, base CSS, or a max-width media query. */
    const wraps = (s: Style) => s.tw.some((t) => /^(flex-wrap|flex-wrap-reverse|flex-col|flex-col-reverse|grid|block|hidden)$/.test(t))
      || s.all.some((t) => /^max-(sm|md|lg):(flex-wrap|flex-col|grid|block)$/.test(t))
      || decl(s, ['base', 'narrow'], 'flex-wrap', /^wrap/) || decl(s, ['base', 'narrow'], 'flex-direction', /column/) || decl(s, ['narrow'], 'display', /grid|block|none/);
    const rigid = (s: Style) => s.tw.some((t) => /^(shrink-0|flex-shrink-0|flex-none|whitespace-nowrap)$/.test(t))
      || decl(s, ['base'], 'flex', /^(none|0 0)/) || decl(s, ['base'], 'flex-shrink', /^0$/) || decl(s, ['base'], 'white-space', /nowrap/);
    const ellipsis = (s: Style) => s.all.some((t) => /(^|:)(truncate|text-ellipsis)$/.test(t)) || decl(s, ['base', 'narrow'], 'text-overflow', /ellipsis/);
    const nowrapText = (s: Style) => (s.tw.includes('whitespace-nowrap') || decl(s, ['base'], 'white-space', /nowrap/))
      && !s.tw.some((t) => /^whitespace-(normal|pre-wrap|pre-line)$/.test(t)) && !decl(s, ['narrow'], 'white-space', /normal|pre-wrap|pre-line/) && !ellipsis(s);
    const controls = (n: ts.Node) => { let k = 0; const v = (x: ts.Node) => { if ((ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) && CONTROL.test(tag(x))) k++; ts.forEachChild(x, v); }; v(n); return k; };
    /** It shows a value ({…}) itself or [#1960 review S4-3] inside a child element: the no-wrap box keeps the
     *  value's full width whatever the child does (an inline child's ellipsis cuts nothing). */
    const showsValue = (el: ts.JsxElement | ts.JsxSelfClosingElement): boolean => ts.isJsxElement(el)
      && el.children.some((c) => (ts.isJsxExpression(c) && !!c.expression && !ts.isJsxElement(c.expression) && !ts.isJsxSelfClosingElement(c.expression))
        || (ts.isJsxElement(c) && showsValue(c)));
    /** A row's children, through {cond && …}, ternaries, fragments. */
    const kids = (el: ts.JsxElement) => {
      const found: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
      const take = (n: ts.Node) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) found.push(n);
        else if (ts.isJsxFragment(n)) n.children.forEach(take);
        else if (ts.isJsxExpression(n) && n.expression) take(n.expression);
        else if (ts.isParenthesizedExpression(n)) take(n.expression);
        else if (ts.isConditionalExpression(n)) { take(n.whenTrue); take(n.whenFalse); }
        else if (ts.isBinaryExpression(n)) take(n.right);
      };
      el.children.forEach(take);
      return found;
    };
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const label = (el: ts.JsxElement | ts.JsxSelfClosingElement) => `<${tag(el)} ${(classAttr(el)?.initializer?.getText() ?? '').replace(/\s+/g, ' ').slice(0, 48)}>`;
    const v = (n: ts.Node) => {
      if (ts.isJsxElement(n)) {
        const rs = style(n);
        if (isRow(rs) && !wraps(rs)) {
          out.rows++;
          for (const k of kids(n)) {
            const ks = style(k);
            if (rigid(ks) && !wraps(ks) && controls(k) >= 2) out.hits.push({ file, line: line(k), text: `R1 ${label(k)} holds ${controls(k)} controls and will not shrink` });
            if (nowrapText(ks) && showsValue(k)) out.hits.push({ file, line: line(k), text: `R2 ${label(k)} no-wrap value, no ellipsis` });
          }
        }
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '__tests__', '__mocks__'].includes(e.name) ? [] : sources(p);
    return /\.tsx$|\.module\.css$/.test(e.name) && !/\.(test|spec|census)\./.test(e.name) ? [p] : [];
  });
}

const keyOf = (h: Hit) => `${h.file} | ${h.text}`;

/** Real hits another lane is fixing (tolerated while they remain; drop each once its PR lands). */
const PENDING_ELSEWHERE: Record<string, string> = {
  'app/dashboard/settings/page.tsx | R1 <span "flex shrink-0 items-center gap-2"> holds 2 controls and will not shrink': 'UI-FIX-WEB U03',
  'app/(app)/orders/[id]/page.tsx | R2 <span {`${styles.statusPill} ${completed ? styles.stat> no-wrap value, no ellipsis': 'UI-FIX-WEB U15',
};

/** Reviewed: it fits at 360px. Every entry must still match a real hit. */
const KNOWN: Record<string, string> = {
  'components/advertiser-campaigns.tsx | R2 <span "sw-status"> no-wrap value, no ellipsis': 'Two rows (campaign card title, creative review): the pill shows a campaign/creative status in words, the longest "pending payment" (~130px at 13px with padding), beside a flex-1 name that wraps; it fits in 312px.',
  'app/(app)/orders/[id]/page.tsx | R2 <span {styles.estimate}> no-wrap value, no ellipsis': 'A short fixed phrase ("About N min prep", ~120px at 13px) beside a heading block that wraps (it has no no-wrap or min-width rule), so the heading takes the line break, not the estimate.',
};

const RESULT = census(Object.fromEntries([...sources(SRC), join(SRC, GLOBALS)].map((p) => [relative(SRC, p), readFileSync(p, 'utf8')])));

describe('[BUG-GUARDS C8] on a 360px phone, nothing in a row is cut off', () => {
  it('reads the pages and their rows (the census is not vacuous)', () => {
    expect(RESULT.files).toBeGreaterThanOrEqual(150);
    expect(RESULT.rows).toBeGreaterThanOrEqual(200); // 233 on main
  });

  it('no row holds a group or a value that cannot fit at 360px (or it is listed with its reason)', () => {
    const offenders = RESULT.hits.filter((h) => !KNOWN[keyOf(h)] && !PENDING_ELSEWHERE[keyOf(h)])
      .map((h) => `${h.file}:${h.line} ${h.text} — at 360px it is cut off (overflow-x: clip). Let the row wrap (flex-wrap / flex-col sm:flex-row), let the group wrap, or truncate the value.`);
    expect(offenders).toEqual([]);
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(RESULT.hits.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-(SWEEP|FIX-WEB|FIX-ADMIN) U\d+$/);
  });

  it('bites: the shapes that were cut off are refused, the ones that wrap pass', () => {
    const verdict = (src: string, css = '', globalsCss = '') => census({ 'p/x.tsx': src, 'p/x.module.css': css, [GLOBALS]: globalsCss }).hits.map((h) => h.text.split(' ')[0]);
    const group = `<span className="flex shrink-0 gap-2"><span>Hand {who}?</span><button>Yes</button><button>Cancel</button></span>`;
    // U03: a rigid group of two buttons in a row that does not wrap.
    expect(verdict(`const P = () => <div className="flex items-center justify-between"><span>{text}</span>${group}</div>;`)).toEqual(['R1']);
    expect(verdict(`const P = () => <div className={ok ? 'flex justify-between' : 'flex'}><span>{text}</span>{open && ${group}}</div>;`)).toEqual(['R1']);
    // An sm: class does nothing at 360px.
    expect(verdict(`const P = () => <div className="flex sm:flex-wrap"><span>{text}</span>${group}</div>;`)).toEqual(['R1']);
    // Passing: the row wraps, stacks, or the group wraps; one control fits.
    expect(verdict(`const P = () => <div className="flex flex-wrap"><span>{text}</span>${group}</div>;`)).toEqual([]);
    expect(verdict(`const P = () => <div className="flex flex-col sm:flex-row"><span>{text}</span>${group}</div>;`)).toEqual([]);
    expect(verdict(`const P = () => <div className="flex"><span>{text}</span><span className="flex shrink-0 flex-wrap gap-2"><button>Yes</button><button>No</button></span></div>;`)).toEqual([]);
    expect(verdict(`const P = () => <div className="flex"><span>{text}</span><button className="shrink-0">Edit</button></div>;`)).toEqual([]);
    // U15: a no-wrap pill showing a value, through a CSS module; an ellipsis or a narrow-screen wrap passes.
    const hero = `import styles from './x.module.css';\nconst P = () => <section className={styles.hero}><h1>{title}</h1><span className={\`\${styles.pill} \${done ? styles.ok : ''}\`}>{label}</span></section>;`;
    expect(verdict(hero, `.hero { display: flex; gap: 16px; }\n.pill { flex: none; white-space: nowrap; }`)).toEqual(['R2']);
    expect(verdict(hero, `.hero { display: flex; }\n.pill { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`)).toEqual([]);
    expect(verdict(hero, `.hero { display: flex; }\n.pill { white-space: nowrap; }\n@media (max-width: 480px) { .hero { flex-wrap: wrap; } }`)).toEqual([]);
    // A min-width query does nothing at 360px.
    expect(verdict(hero, `.hero { display: flex; }\n.pill { white-space: nowrap; }\n@media (min-width: 640px) { .hero { flex-wrap: wrap; } }`)).toEqual(['R2']);
    // Tailwind: no-wrap value refused; fixed words and a truncated value pass.
    expect(verdict(`const P = () => <div className="flex"><b>{name}</b><span className="whitespace-nowrap">{status}</span></div>;`)).toEqual(['R2']);
    expect(verdict(`const P = () => <div className="flex"><b>{name}</b><span className="whitespace-nowrap">Rider fees</span></div>;`)).toEqual([]);
    expect(verdict(`const P = () => <div className="flex"><b>{name}</b><span className="whitespace-nowrap truncate">{status}</span></div>;`)).toEqual([]);
    // Not a row: block / grid.
    expect(verdict(`const P = () => <div className="grid"><span>{text}</span>${group}</div>;`)).toEqual([]);
  });

  it('bites (#1960 review): global design-system classes, component buttons, a class held in a const, inline styles, a value one element down', () => {
    const verdict = (src: string, globalsCss = '') => census({ 'p/x.tsx': src, [GLOBALS]: globalsCss }).hits.map((h) => h.text.split(' ')[0]);
    // S3-1: .sw-row / .sw-status live in globals.css (after a block-less @import).
    const pill = `const P = () => <div className="sw-row"><b>{name}</b><span className="sw-status">{status}</span></div>;`;
    const globalsCss = `@import 'tailwindcss';\n.sw-row { display: flex; gap: 12px; }\n@layer components {\n  .sw-status { display: inline-flex; white-space: nowrap; }\n}`;
    expect(verdict(pill, globalsCss)).toEqual(['R2']);
    expect(verdict(pill, globalsCss.replace('white-space: nowrap;', 'white-space: nowrap; text-overflow: ellipsis;'))).toEqual([]);
    expect(verdict(pill, globalsCss.replace('display: flex;', 'display: flex; flex-wrap: wrap;'))).toEqual([]);
    // S4-1: a rigid group of two component buttons.
    expect(verdict(`const P = () => <div className="flex"><span>{t}</span><span className="flex shrink-0 gap-2"><PillButton /><SignOutButton /></span></div>;`)).toEqual(['R1']);
    expect(verdict(`const P = () => <div className="flex"><span>{t}</span><span className="flex shrink-0 gap-2"><Nav.Link href="/a">A</Nav.Link><Pill /></span></div>;`)).toEqual([]);
    // S4-2: the row class in a const, and inline style rows.
    expect(verdict(`const row = 'flex items-center';\nconst P = () => <div className={row}><b>{name}</b><span className="whitespace-nowrap">{status}</span></div>;`)).toEqual(['R2']);
    expect(verdict(`const row = open ? 'flex' : 'flex gap-2';\nconst P = () => <div className={row}><b>{name}</b><span className="whitespace-nowrap">{status}</span></div>;`)).toEqual(['R2']);
    expect(verdict(`const row = 'flex flex-wrap';\nconst P = () => <div className={row}><b>{name}</b><span className="whitespace-nowrap">{status}</span></div>;`)).toEqual([]);
    expect(verdict(`const P = () => <div style={{ display: 'flex' }}><b>{name}</b><span style={{ whiteSpace: 'nowrap' }}>{status}</span></div>;`)).toEqual(['R2']);
    expect(verdict(`const P = () => <div style={{ display: 'flex', flexWrap: 'wrap' }}><b>{name}</b><span style={{ whiteSpace: 'nowrap' }}>{status}</span></div>;`)).toEqual([]);
    // S4-3: the value one element down.
    expect(verdict(`const P = () => <div className="flex"><b>{name}</b><span className="whitespace-nowrap"><strong>{status}</strong></span></div>;`)).toEqual(['R2']);
    expect(verdict(`const P = () => <div className="flex"><b>{name}</b><span className="whitespace-nowrap"><strong>Paid</strong></span></div>;`)).toEqual([]);
  });
});
