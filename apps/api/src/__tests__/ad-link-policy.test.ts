import { describe, expect, it } from 'vitest';
import { classifyAdLink, AD_LINK_MAX_LENGTH } from '../modules/ads/ad-link-policy';

// [ADS-ON · 4 Oct ruling] What an ad may open. Pure: nothing here reads the network or the allow-list.
describe('ad link policy: the shape of a link', () => {
  it('no destination is nothing to open, and a stray value is dropped', () => {
    expect(classifyAdLink('NONE', null)).toEqual({ ok: true, kind: 'NONE' });
    expect(classifyAdLink('NONE', 'https://example.gy')).toEqual({ ok: true, kind: 'NONE' });
  });

  it.each(['URL', 'DEEPLINK'] as const)('%s needs a link', (type) => {
    expect(classifyAdLink(type, null)).toEqual({ ok: false, reason: 'LINK_MISSING' });
    expect(classifyAdLink(type, '   ')).toEqual({ ok: false, reason: 'LINK_MISSING' });
  });

  it('an outside link is https on a public name, stored as the parser reads it, keyed by its host without www', () => {
    expect(classifyAdLink('URL', 'https://Shop.Example.gy/deals?x=1#top')).toEqual({
      ok: true, kind: 'EXTERNAL', value: 'https://shop.example.gy/deals?x=1#top', host: 'shop.example.gy',
    });
    expect(classifyAdLink('URL', 'https://www.example.gy/')).toEqual({ ok: true, kind: 'EXTERNAL', value: 'https://www.example.gy/', host: 'example.gy' });
  });

  it.each([
    ['http://example.gy/', 'HTTPS_REQUIRED'],
    ['ftp://example.gy/', 'HTTPS_REQUIRED'],
    ['javascript:alert(1)', 'HTTPS_REQUIRED'],
    ['data:text/html,hi', 'HTTPS_REQUIRED'],
    ['intent://scan/#Intent;scheme=zxing;end', 'HTTPS_REQUIRED'],
    ['tel:+5926001234', 'HTTPS_REQUIRED'],
    ['swift://store/a-store', 'HTTPS_REQUIRED'],
    ['example.gy', 'LINK_MALFORMED'],
    ['https://', 'LINK_MALFORMED'],
    ['https://user:pw@example.gy/', 'CREDENTIALS_FORBIDDEN'],
    ['https://example.gy@evil.example/', 'CREDENTIALS_FORBIDDEN'],
    ['https://example.gy:8443/', 'PORT_FORBIDDEN'],
    ['https://127.0.0.1/', 'IP_OR_LOCAL_HOST'],
    ['https://2130706433/', 'IP_OR_LOCAL_HOST'],
    ['https://0x7f.1/', 'IP_OR_LOCAL_HOST'],
    ['https://[::1]/', 'IP_OR_LOCAL_HOST'],
    ['https://169.254.169.254/latest', 'IP_OR_LOCAL_HOST'],
    ['https://localhost/', 'IP_OR_LOCAL_HOST'],
    ['https://printer/', 'IP_OR_LOCAL_HOST'],
    ['https://box.local/', 'IP_OR_LOCAL_HOST'],
    ['https://db.internal/', 'IP_OR_LOCAL_HOST'],
    ['https://example.gy./', 'IP_OR_LOCAL_HOST'],
    ['https://xn--pple-43d.com/', 'PUNYCODE_HOST'],
    ['https://аpple.com/', 'PUNYCODE_HOST'],
    ['https://bit.ly/abc', 'URL_SHORTENER'],
    ['https://www.bit.ly/abc', 'URL_SHORTENER'],
    ['https://tinyurl.com/abc', 'URL_SHORTENER'],
    ['https://t.co/abc', 'URL_SHORTENER'],
    ['https://example.gy/app.apk', 'FILE_DOWNLOAD'],
    ['https://example.gy/Setup.EXE', 'FILE_DOWNLOAD'],
    ['https://example.gy/get%2Eapk', 'FILE_DOWNLOAD'],
    ['https://example.gy/a.msi?x=1', 'FILE_DOWNLOAD'],
    ['https://example.gy/a.zip#y', 'FILE_DOWNLOAD'],
  ])('refuses %s: %s', (value, reason) => {
    expect(classifyAdLink('URL', value)).toEqual({ ok: false, reason });
  });

  it.each([
    'https://example.gy\\@evil.example/',
    'https:\\\\evil.example/',
    'https://example.gy/a b',
    'https://example.gy/\ta',
    'https://example.gy/\u0000',
    ' https://example.gy/x y ',
  ])('refuses a value two parsers could read differently: %j', (value) => {
    expect(classifyAdLink('URL', value)).toEqual({ ok: false, reason: 'LINK_MALFORMED' });
  });

  it('refuses a link longer than the column allows', () => {
    expect(classifyAdLink('URL', `https://example.gy/${'a'.repeat(AD_LINK_MAX_LENGTH)}`)).toEqual({ ok: false, reason: 'LINK_MALFORMED' });
  });
});

describe('ad link policy: app stores are their own kind', () => {
  it.each([
    ['https://apps.apple.com/gy/app/some-app/id1234567890', 'apps.apple.com'],
    ['https://apps.apple.com/app/id1234567890', 'apps.apple.com'],
    ['https://play.google.com/store/apps/details?id=gy.example.app', 'play.google.com'],
  ])('%s is an app store link', (value, host) => {
    expect(classifyAdLink('URL', value)).toEqual({ ok: true, kind: 'APP_STORE', value, host });
  });

  it.each([
    'https://apps.apple.com/',
    'https://apps.apple.com/gy/developer/x/id1',
    'https://play.google.com/',
    'https://play.google.com/store/search?q=x',
    'https://play.google.com/store/apps/details',
    'https://play.google.com/store/apps/details?id=not-a-package',
    'https://play.google.com/store/apps/dev?id=123',
  ])('an app store host only opens one app: %s', (value) => {
    expect(classifyAdLink('URL', value)).toEqual({ ok: false, reason: 'APP_STORE_PATH' });
  });
});

describe('ad link policy: inside Swift', () => {
  it.each(['swift://store/roti-shop-AbC_123', 'swift://s/23456789bc'])('%s is a Swift link', (value) => {
    expect(classifyAdLink('DEEPLINK', value)).toEqual({ ok: true, kind: 'INSIDE_SWIFT', value });
  });

  it.each([
    'https://swiftgy.com/store/x',
    'swift://pay/mmg/return',
    'swift://pay/card/return',
    'swift://store/',
    'swift://store/a/b',
    'swift://store/a?c=1',
    'swift://store/a#x',
    'swift://evil.example/store/a',
    'swift://user@store/a',
    'swift://store:1/a',
    'swift://s/short',
    'SWIFT://store/a',
    'tel:+5926001234',
    'intent://x',
    'javascript:alert(1)',
  ])('refuses %s: only the two shapes the app opens', (value) => {
    expect(classifyAdLink('DEEPLINK', value)).toEqual({ ok: false, reason: 'NOT_A_SWIFT_LINK' });
  });
});
