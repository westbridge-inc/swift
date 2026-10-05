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
  it.each(['+15927163534', '71635340', '2026-13-45', '1 '.repeat(999).trim()])('refuses phone-like candidates %s', (text) => {
    expect(chatContentReason(text)).toBe('PHONE');
  });
  it.each(['skunt', 'ANTIMAN', 'fúck', 'fu\u200bck'])('reuses review language matching with normalized text', (text) => {
    expect(chatContentReason(text)).toBe('LANGUAGE');
  });
});
