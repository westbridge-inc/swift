/**
 * [WEB-SETTINGS · owner 31 Oct 2026] The store's MMG number is where its customers' money goes, so the website shows
 * it masked only: "+592 ••• •234". The last three digits are enough for the owner to tell their own number from one
 * they did not set ("This wasn't me"); the rest never reaches the screen. A value of any other shape is masked whole.
 * The server judges what a valid number is (and sends only valid ones); this only decides what is shown.
 */
export function maskMmgNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 10 && digits.startsWith('592') ? digits.slice(3) : digits;
  return national.length === 7 ? `+592 ••• •${national.slice(-3)}` : '+592 ••• ••••';
}
