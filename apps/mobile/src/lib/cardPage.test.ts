import { describe, expect, it } from 'vitest';
import {
  cardApiOrigin, cardMainFrameAllowed, cardMainFrameLeft, cardPageDecision, cardPageEmbeddable, cardSheetFor, isCardReturnLink, isCardReturnPage,
} from './cardPage';

// The in-app card sheet (CARD embed): where it may go, and how it knows the partner is
// done. Synthetic hosts only; the card provider's domain is the one the server pins.
const API = 'https://api.example.test';
const PAGE = `${API}/api/v1/billing/card/pay/ref_0123456789abcdef`;
const PROVIDER = 'https://staging.ptranz.com/HPP/form';
const BANK = 'https://acs.bank.example/challenge';
const RETURN_PAGE = `${API}/api/v1/billing/card/return?s=session&state=one-use`;

describe('the card sheet knows only its own API origin', () => {
  it('reads the origin the app talks to, and nothing that is not a plain web origin', () => {
    expect(cardApiOrigin('https://api.example.test/')).toBe(API);
    expect(cardApiOrigin('http://10.0.2.2:3000')).toBe('http://10.0.2.2:3000');
    expect(cardApiOrigin('https://user:pw@api.example.test')).toBeNull();
    expect(cardApiOrigin('swift://pay')).toBeNull();
    expect(cardApiOrigin('not a url')).toBeNull();
    expect(cardApiOrigin(undefined)).toBeNull();
  });
});

describe('where the card sheet may go (allow-list)', () => {
  it('the main frame shows only Swift’s API origin or the card provider', () => {
    expect(cardPageDecision({ url: PAGE, isTopFrame: true }, API)).toBe('allow');
    expect(cardPageDecision({ url: RETURN_PAGE, isTopFrame: true }, API)).toBe('allow');
    expect(cardPageDecision({ url: PROVIDER, isTopFrame: true }, API)).toBe('allow');
    expect(cardPageDecision({ url: BANK, isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'https://swiftgy.example/weekly-fee', isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'https://evilptranz.com/x', isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'https://ptranz.com.evil.example/x', isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'http://staging.ptranz.com/x', isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'https://staging.ptranz.com:8443/x', isTopFrame: true }, API)).toBe('block');
    expect(cardPageDecision({ url: 'about:blank', isTopFrame: true }, API)).toBe('block');
  });

  it('a frame inside the page may show the card’s bank over https (3-D Secure), and its own frame documents', () => {
    expect(cardPageDecision({ url: BANK, isTopFrame: false }, API)).toBe('allow');
    expect(cardPageDecision({ url: PROVIDER, isTopFrame: false }, API)).toBe('allow');
    expect(cardPageDecision({ url: 'about:srcdoc', isTopFrame: false }, API)).toBe('allow');
    expect(cardPageDecision({ url: 'about:blank' }, API)).toBe('allow');
    expect(cardPageDecision({ url: 'http://acs.bank.example/challenge', isTopFrame: false }, API)).toBe('block');
  });

  it.each([
    'tel:+5920000000', 'mailto:x@example.test', 'intent://scan#Intent;scheme=zxing;end', 'javascript:alert(1)', 'file:///etc/hosts',
    'data:text/html,<p>x</p>', 'itms-apps://apps.apple.com/app/id1', 'swift://orders', 'http://api.other.test/x', 'https://user:pw@api.example.test/x', '',
  ])('never loads or hands to another app: %s', (url) => {
    for (const isTopFrame of [true, false, undefined]) expect(cardPageDecision({ url, ...(isTopFrame === undefined ? {} : { isTopFrame }) }, API)).toBe('block');
  });

  it('Android cannot tell a frame from the main frame: https may start, and the main frame is checked again when it loads', () => {
    expect(cardPageDecision({ url: BANK }, API)).toBe('allow');
    expect(cardMainFrameLeft(BANK, API)).toBe(true);
    expect(cardMainFrameLeft('https://swiftgy.example/weekly-fee', API)).toBe(true);
    expect(cardMainFrameLeft(PAGE, API)).toBe(false);
    expect(cardMainFrameLeft(PROVIDER, API)).toBe(false);
    expect(cardMainFrameLeft('about:blank', API)).toBe(false);
    expect(cardMainFrameLeft(undefined, API)).toBe(false);
  });

  it('a development API over http is its own origin, exactly — no other http host', () => {
    const dev = 'http://10.0.2.2:3000';
    expect(cardPageDecision({ url: `${dev}/api/v1/billing/card/simulator/sim_1`, isTopFrame: true }, dev)).toBe('allow');
    expect(cardPageDecision({ url: 'http://10.0.2.2:3001/x', isTopFrame: true }, dev)).toBe('block');
    expect(cardMainFrameAllowed('http://10.0.2.2:3001/x', dev)).toBe(false);
  });
});

describe('how the card sheet knows the partner is done (return detection)', () => {
  it('the return link closes the sheet, in any frame', () => {
    for (const isTopFrame of [true, false, undefined]) {
      expect(cardPageDecision({ url: 'swift://pay/card/return', ...(isTopFrame === undefined ? {} : { isTopFrame }) }, API)).toBe('return');
    }
    expect(isCardReturnLink('swift://pay/card/return?from=page')).toBe(true);
    expect(isCardReturnLink('swift://pay/card/returned')).toBe(false);
    expect(isCardReturnLink('swift://pay/card')).toBe(false);
  });

  it('the server’s return page reaching the main frame ends the page; the same path elsewhere does not', () => {
    expect(isCardReturnPage(RETURN_PAGE, API)).toBe(true);
    expect(isCardReturnPage(`${API}/api/v1/billing/card/return`, API)).toBe(true);
    expect(isCardReturnPage('https://other.example/api/v1/billing/card/return', API)).toBe(false);
    expect(isCardReturnPage(PAGE, API)).toBe(false);
  });
});

describe('which card pages open in the sheet', () => {
  const webView = () => 'WebView';
  it('only a page on this app’s API origin (or the provider), only on a build that has the web view', () => {
    expect(cardPageEmbeddable(PAGE, API)).toBe(true);
    expect(cardPageEmbeddable(PROVIDER, API)).toBe(true);
    expect(cardPageEmbeddable('https://elsewhere.example/pay', API)).toBe(false);
    expect(cardPageEmbeddable(PAGE, null)).toBe(false);
    expect(cardSheetFor(PAGE, webView, () => API)).toEqual({ WebView: 'WebView', apiOrigin: API });
    expect(cardSheetFor('https://elsewhere.example/pay', webView, () => API)).toBeNull();
  });

  it('a build without the web view, or an unreadable API address, opens the in-app browser instead', () => {
    let asked = false;
    expect(cardSheetFor(PAGE, () => null, () => { asked = true; return API; })).toBeNull();
    expect(asked).toBe(false);
    expect(cardSheetFor(PAGE, webView, () => { throw new Error('no export'); })).toBeNull();
    expect(cardSheetFor(PAGE, webView, () => undefined)).toBeNull();
  });
});
