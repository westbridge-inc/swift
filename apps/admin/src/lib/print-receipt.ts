/**
 * [OWNER 5 Nov 2026 · REVIEW S3] A receipt goes to one partner, so only its lines reach the paper: they are printed from
 * a frame of their own, never with the Finance page and its other accounts around them. If the frame cannot print,
 * nothing is printed.
 */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The whole document that is printed: these lines and nothing else. */
export function receiptPrintDocument(lines: readonly string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Receipt</title></head><body style="font-family:sans-serif">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</body></html>`;
}

export function printReceipt(lines: readonly string[]): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.addEventListener('load', () => {
    const view = frame.contentWindow;
    view?.addEventListener('afterprint', () => frame.remove());
    view?.focus();
    view?.print?.();
  }, { once: true });
  frame.srcdoc = receiptPrintDocument(lines);
  document.body.appendChild(frame);
}
