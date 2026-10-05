import { spawn } from 'node:child_process';
import { AppError } from './errors';

const MAX_INPUT = 5 * 1024 * 1024;
const MAX_OUTPUT = 128 * 1024;
const activeOwners = new Set<string>();

/** Supervisor shared by the production parser and bounded hostile fixtures.
 * The Linux runtime's kernel limits cover native allocations as well as V8.
 * Other runtimes refuse the feature; a JS timer/heap cap is not a substitute.
 * Input/output use pipes, so every exit path leaves no temporary documents. */
export function runBoundedPdfProcess(script: string, input: Buffer, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'linux') {
    return Promise.reject(new AppError(503, 'MENU_PARSER_UNAVAILABLE', 'PDF import requires the isolated Linux parser runtime'));
  }
  if (input.length > MAX_INPUT) return Promise.reject(new AppError(400, 'BAD_MENU_FILE', 'PDF exceeds the input limit'));
  if (signal?.aborted) return Promise.reject(new AppError(400, 'BAD_MENU_FILE', 'PDF import cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [
      '-c', 'ulimit -c 0 && ulimit -t 10 && ulimit -v 2097152 && exec "$@"',
      'menu-pdf', process.execPath, '--jitless', '--max-old-space-size=256', '--max-semi-space-size=8', '-e', script,
    ], { cwd: '/', env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let size = 0;
    let stderrSize = 0;
    const chunks: Buffer[] = [];
    const stop = (message: string) => {
      failure ??= new AppError(400, 'BAD_MENU_FILE', message);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('PDF exceeded its processing limit'), 15_000);
    const abort = () => stop('PDF import cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) stop('PDF exceeds the text limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 16 * 1024) stop('Could not read that PDF');
    });
    child.on('error', () => stop('PDF parser could not start'));
    child.stdin.on('error', () => stop('PDF parser input failed'));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure ?? new AppError(400, 'BAD_MENU_FILE', 'Could not read that PDF'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(input);
    // Abort may have happened between the first check and listener install.
    if (signal?.aborted) abort();
  });
}

export async function extractMenuPdf(buffer: Buffer, owner: string, signal?: AbortSignal): Promise<string> {
  if (buffer.length > MAX_INPUT || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new AppError(400, 'BAD_MENU_FILE', 'Could not read that PDF');
  }
  // No waiting queue. One job per owner and two per API process bound both
  // retained input and worker count; a saturated request receives backoff.
  if (activeOwners.has(owner) || activeOwners.size >= 2) {
    throw new AppError(429, 'MENU_PARSER_BUSY', 'PDF import is busy. Try again shortly.', { retryAfterSeconds: 15 });
  }
  activeOwners.add(owner);
  try {
    const parserModule = JSON.stringify(require.resolve('pdf-parse'));
    return await runBoundedPdfProcess(`
      const { PDFParse } = require(${parserModule});
      const chunks = []; let size = 0;
      process.stdin.on('data', chunk => {
        size += chunk.length;
        if (size > ${MAX_INPUT}) process.exit(1);
        chunks.push(chunk);
      });
      process.stdin.on('end', async () => {
        let parser;
        try {
          parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false });
          const info = await parser.getInfo();
          if (!Number.isInteger(info.total) || info.total < 1 || info.total > 50) process.exit(1);
          const result = await parser.getText();
          const text = result.text || '';
          if (Buffer.byteLength(text, 'utf8') > ${MAX_OUTPUT}) process.exit(1);
          await parser.destroy();
          process.stdout.end(text, () => process.exit(0));
        } catch { process.exit(1); }
      });
    `, buffer, signal);
  } finally { activeOwners.delete(owner); }
}
