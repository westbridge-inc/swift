import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cartErrorMessage } from './cart-presentation';
import { ApiRequestError } from './auth';

/** Parse text and string/template literals, excluding comments and identifier
 * names. A copy regression must fail even on a rarely reached error branch. */
function copyIn(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const copy: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) copy.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return copy;
}

describe('cart customer copy census', () => {
  it.each(['src/app/(app)/cart/page.tsx', 'src/lib/cart-presentation.ts'])('%s has no technical customer strings', (path) => {
    const jargon = /\b(lines|server|aggregate|fulfilment|fulfillment|idempotenc\w*|single-store|truthful)\b/i;
    expect(copyIn(path).filter((copy) => jargon.test(copy))).toEqual([]);
  });

  it('never renders raw checkout diagnostics', () => {
    const diagnostic = 'server quote contains mixed saved lines';
    expect(cartErrorMessage(new ApiRequestError(diagnostic, 500))).toBe('Could not update your cart. Please try again.');
    expect(cartErrorMessage(new Error(diagnostic))).toBe('Could not update your cart. Please try again.');
    expect(cartErrorMessage(new ApiRequestError(diagnostic, 400, 'MMG_INVALID'))).toContain('MMG is unavailable');
  });

  it.each([
    ['DELIVERY_NO_RIDERS', 'No delivery riders'], ['VENDOR_CLOSED', 'closed'],
    ['INSUFFICIENT_STOCK', 'Reduce its quantity'], ['ITEM_UNAVAILABLE', 'Remove it'],
    ['ID_VERIFICATION_REQUIRED', 'verify your identity'], ['ACCOUNT_RESTRICTED', 'Contact support'],
    ['STRIKE_RESTRICTED', 'Contact support'], ['OUT_OF_RANGE', 'closer delivery address'],
    ['MIN_ORDER', 'minimum order amount'], ['CART_CHANGED', 'Review your items'],
    ['PROMO_WRONG_VENDOR', 'another store. Remove it to continue'],
    ['INVALID_PROMO', 'no longer available. Remove it to continue'],
    ['EXPIRED_PROMO', 'expired. Remove it to continue'],
    ['USED_PROMO', 'cannot be used again. Remove it to continue'],
    ['MIN_ORDER_PROMO', 'minimum amount for this promo code. Remove it to continue'],
    ['PROMO_UNAVAILABLE_CASH_DELIVERY', 'cannot be used for cash delivery. Remove it to continue'],
  ])('keeps %s actionable without diagnostics', (code, copy) => {
    expect(cartErrorMessage(new ApiRequestError('server diagnostic', 400, code))).toContain(copy);
  });
});
