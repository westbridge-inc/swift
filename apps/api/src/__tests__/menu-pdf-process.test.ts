import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import PDFDocument from 'pdfkit';
import { extractMenuPdf, runBoundedPdfProcess } from '../utils/menu-pdf-process';

async function pdf(pages = 1): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (let i = 0; i < pages; i++) {
    if (i) doc.addPage();
    doc.text('Menu: chicken curry $1,200 and rice $500');
  }
  doc.end();
  return done;
}

describe('MASTER-006 disposable PDF process', () => {
  it('rejects wrong magic and oversized input before starting a process', async () => {
    await expect(extractMenuPdf(Buffer.from('not a pdf'), 'owner')).rejects.toMatchObject({ code: 'BAD_MENU_FILE' });
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
    huge.write('%PDF-');
    await expect(extractMenuPdf(huge, 'owner')).rejects.toMatchObject({ code: 'BAD_MENU_FILE' });
  });

  it('requires kernel resource limits and never falls back to in-process parsing', async () => {
    const job = runBoundedPdfProcess("process.stdout.end('bounded fixture')", Buffer.alloc(0));
    if (process.platform === 'linux') await expect(job).resolves.toBe('bounded fixture');
    else await expect(job).rejects.toMatchObject({ code: 'MENU_PARSER_UNAVAILABLE' });
  });

  it('keeps the API responsive during a non-yielding job and kills it on cancellation', async () => {
    const app = Fastify({ logger: false });
    app.get('/live', () => ({ ok: true }));
    const abort = new AbortController();
    const outcome = runBoundedPdfProcess('for (;;) {}', Buffer.alloc(0), abort.signal).catch(error => error);
    try {
      expect((await app.inject('/live')).json()).toEqual({ ok: true });
      abort.abort();
      expect(await outcome).toMatchObject({ code: process.platform === 'linux' ? 'BAD_MENU_FILE' : 'MENU_PARSER_UNAVAILABLE' });
    } finally { abort.abort(); await app.close(); }
  });

  it('rejects CPU, external-memory, and output exhaustion without leaving a stuck job', async () => {
    for (const script of [
      'for (;;) {}',
      'const held=[]; for (;;) held.push(Buffer.alloc(16*1024*1024,1));',
      "process.stdout.write('x'.repeat(256*1024));",
    ]) {
      await expect(runBoundedPdfProcess(script, Buffer.alloc(0))).rejects.toMatchObject({
        code: process.platform === 'linux' ? 'BAD_MENU_FILE' : 'MENU_PARSER_UNAVAILABLE',
      });
    }
  }, 30_000);

  it('reads legitimate multipage menus and rejects excessive pages', async () => {
    const input = await pdf(2);
    if (process.platform === 'linux') {
      await expect(extractMenuPdf(input, 'real-menu')).resolves.toContain('chicken curry');
      await expect(extractMenuPdf(await pdf(51), 'real-menu')).rejects.toMatchObject({ code: 'BAD_MENU_FILE' });
    } else {
      await expect(extractMenuPdf(input, 'real-menu')).rejects.toMatchObject({ code: 'MENU_PARSER_UNAVAILABLE' });
    }
  });

  it('rejects concurrent work for an owner and releases capacity after completion', async () => {
    const input = await pdf();
    const first = extractMenuPdf(input, 'same-owner').catch(error => error);
    await expect(extractMenuPdf(input, 'same-owner')).rejects.toMatchObject({ code: 'MENU_PARSER_BUSY' });
    await first;
    const next = await extractMenuPdf(input, 'same-owner').catch(error => error);
    if (process.platform === 'linux') expect(next).toContain('chicken curry');
    else expect(next).toMatchObject({ code: 'MENU_PARSER_UNAVAILABLE' });
  });
});
