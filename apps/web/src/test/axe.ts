import axe from 'axe-core';

/**
 * [Row 111 · W8] Accessibility violations axe finds in what a test rendered, one line
 * each ("rule: element"). Colour contrast is left out: the test DOM has no layout or
 * computed colours to judge it by. Page-level rules (a main landmark, one h1, a way
 * to skip to content) apply only when `page` is set: a component alone is not a page.
 */
export async function axeViolations(root: Element = document.body, { page = false }: { page?: boolean } = {}): Promise<string[]> {
  const off = ['color-contrast', ...(page ? [] : ['region', 'landmark-one-main', 'page-has-heading-one', 'bypass', 'landmark-complementary-is-top-level'])];
  const results = await axe.run(root, { rules: Object.fromEntries(off.map((id) => [id, { enabled: false }])) });
  return results.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.html.slice(0, 160)}`));
}
