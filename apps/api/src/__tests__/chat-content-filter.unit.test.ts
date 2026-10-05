import { describe, expect, it } from 'vitest';
import { chatContentReason } from '../modules/chat/content-filter';

describe('bounded chat contact patterns', () => {
  it.each([
    'https://swiftgy.com/contact.', '(https://swiftgy.com/contact)',
    'HTTPS://SWIFTGY.COM/contact', 'https://swiftgy.com/contact/',
    '+592 (716) 3534', 'GYD 1000000', '$1000000.00', '2028-02-29',
    'SW-260715-001QDB', 'assignment arrives soon',
  ])('allows the complete supported pattern %s', (text) => {
    expect(chatContentReason(text)).toBeUndefined();
  });
  it.each([
    'http://swiftgy.com/contact', 'https://swiftgy.com/contact#other',
    'https://swiftgy.com/contact/more', 'https://swiftgy.com/Contact',
    'https://swiftgy.com:444/contact', 'https://swiftgy.com/contact?x=1',
    'swiftgy.com/contact', 'www.swiftgy.com/contact', 'name@outside.example',
    'javascript:alert(1)', 'ftp://outside.example', 'https://swiftgy.com\\@outside.example/contact',
  ])('refuses links outside the complete canonical exception %s', (text) => {
    expect(chatContentReason(text)).toBe('LINK');
  });
  it.each([
    'meet at 11.am', 'see you 3.pm', 'I.am on my way', 'it.was good', 'come.to the gate',
    'no.in stock', 'he.said hi', 'we.are here', 'do.it now', 'she.loves it',
  ])('does not mistake ordinary words joined by a dot for a link: %s', (text) => {
    expect(chatContentReason(text)).toBeUndefined();
  });
  it.each(['visit shop.gy today', 'join t.me/swiftdeals', 'see example.com', 'mysite.online/menu', 'order at food.store'])(
    'still refuses a bare web address %s', (text) => {
      expect(chatContentReason(text)).toBe('LINK');
    },
  );
  it.each(['call-6001000', 'tel-5926001000', 'my-592-600-1000', '$5926001000', 'GYD 5926001000'])(
    'refuses a number joined by a hyphen or dressed as a currency amount %s', (text) => {
      expect(chatContentReason(text)).toBe('PHONE');
    },
  );
  it.each(['SW-260715-001234', 'order SW-260715-001QDB arrived'])('allows an order reference %s', (text) => {
    expect(chatContentReason(text)).toBeUndefined();
  });
  it.each(['05-10-2026', '5-10-2026', '31.12.2026', '29-02-2028', 'deliver on 05-10-2026 please'])('allows a day-month-year date %s', (text) => {
    expect(chatContentReason(text)).toBeUndefined();
  });
  it.each(['+15927163534', '71635340', '2026-13-45', '31-02-2026', '45-13-2026', '29-02-2027', '1 '.repeat(999).trim()])('refuses phone-like candidates %s', (text) => {
    expect(chatContentReason(text)).toBe('PHONE');
  });
  it.each(['skunt', 'ANTIMAN', 'fúck', 'fu\u200bck'])('reuses review language matching with normalized text', (text) => {
    expect(chatContentReason(text)).toBe('LANGUAGE');
  });
});
