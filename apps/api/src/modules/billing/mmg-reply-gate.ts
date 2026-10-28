import { performance } from 'node:perf_hooks';
import { decodeCheckoutToken } from '../../providers/mmg/mmg-checkout';

// ---------------------------------------------------------------------------
// [SEC-DOS F8] Opening an MMG reply is an RSA private-key operation, and it is
// SYNCHRONOUS: while it runs, the API's one event loop serves nobody. The
// public return and notify doors take a reply from anyone, so what is bounded
// here is the WORK, not the doors:
//   - a value that cannot be one RSA block of a key Swift could hold (2048 to
//     8192 bits) is refused before it waits for anything (cheap: base64 only);
//   - one private-key operation at a time, process-wide, and the event loop
//     gets a turn before each one, and again for as long as the last one took
//     before the next starts: decryption can use at most about half of the
//     loop's time, however many replies arrive;
//   - a bounded wait: at most MAX_WAITING replies wait in all, at most
//     MAX_WAITING_PER_SOURCE from one source, each for at most MAX_WAIT_MS.
//     Past that a reply is refused as BUSY: retryable, never an answer about
//     the payment. A few sources sending junk fill only their own share.
// Nothing here decides a payment: a reply is a pointer, and only MMG's own
// lookup confirms one.
// ---------------------------------------------------------------------------

export const REPLY_GATE_MAX_WAITING = 32;
export const REPLY_GATE_MAX_WAITING_PER_SOURCE = 4;
export const REPLY_GATE_MAX_WAIT_MS = 2_000;
/** The pause after one operation is as long as it took, capped here. */
const MAX_PACE_MS = 50;
/** The smallest and largest RSA block a reply token can be (2048- to 8192-bit keys). */
const MIN_BLOCK_BYTES = 256;
const MAX_BLOCK_BYTES = 1024;

/** The reply could not be opened now: too many are waiting. Retryable; says nothing about any payment. */
export class ReplyGateBusyError extends Error {
  constructor() {
    super('Too many MMG replies are waiting to be opened; try again shortly.');
    this.name = 'ReplyGateBusyError';
  }
}

/** Cheap: canonical base64 or base64url whose bytes could be one RSA block of a key Swift could hold. */
export function plausibleReplyToken(value: string): boolean {
  if (value.length > Math.ceil(MAX_BLOCK_BYTES / 3) * 4) return false;
  try {
    const bytes = decodeCheckoutToken(value).length;
    return bytes >= MIN_BLOCK_BYTES && bytes <= MAX_BLOCK_BYTES;
  } catch {
    return false;
  }
}

interface Waiter {
  source: string;
  admit: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReplyGateOptions {
  maxWaiting?: number;
  maxWaitingPerSource?: number;
  maxWaitMs?: number;
}

export class ReplyDecryptGate {
  private held = false;
  private readonly waiting: Waiter[] = [];
  private readonly waitingBySource = new Map<string, number>();
  private readonly maxWaiting: number;
  private readonly maxWaitingPerSource: number;
  private readonly maxWaitMs: number;

  constructor(options: ReplyGateOptions = {}) {
    this.maxWaiting = options.maxWaiting ?? REPLY_GATE_MAX_WAITING;
    this.maxWaitingPerSource = options.maxWaitingPerSource ?? REPLY_GATE_MAX_WAITING_PER_SOURCE;
    this.maxWaitMs = options.maxWaitMs ?? REPLY_GATE_MAX_WAIT_MS;
  }

  /** How many replies are waiting now (for tests and logs). */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Runs one private-key operation under the gate, or throws ReplyGateBusyError. */
  async run<T>(source: string, work: () => T): Promise<T> {
    await this.acquire(source);
    let tookMs = 0;
    try {
      // The event loop's turn before the operation: whatever is ready runs first.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const started = performance.now();
      try {
        return work();
      } finally {
        tookMs = performance.now() - started;
      }
    } finally {
      this.release(tookMs);
    }
  }

  private acquire(source: string): Promise<void> {
    if (!this.held && this.waiting.length === 0) {
      this.held = true;
      return Promise.resolve();
    }
    const fromSource = this.waitingBySource.get(source) ?? 0;
    if (this.waiting.length >= this.maxWaiting || fromSource >= this.maxWaitingPerSource) {
      return Promise.reject(new ReplyGateBusyError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        source,
        admit: resolve,
        timer: setTimeout(() => {
          const at = this.waiting.indexOf(waiter);
          if (at === -1) return;
          this.waiting.splice(at, 1);
          this.forget(source);
          reject(new ReplyGateBusyError());
        }, this.maxWaitMs),
      };
      this.waiting.push(waiter);
      this.waitingBySource.set(source, fromSource + 1);
    });
  }

  private release(tookMs: number): void {
    // The loop gets as long again as the operation took before the next one starts.
    setTimeout(() => {
      const next = this.waiting.shift();
      if (!next) {
        this.held = false;
        return;
      }
      clearTimeout(next.timer);
      this.forget(next.source);
      next.admit();
    }, Math.min(MAX_PACE_MS, Math.ceil(tookMs)));
  }

  private forget(source: string): void {
    const left = (this.waitingBySource.get(source) ?? 1) - 1;
    if (left <= 0) this.waitingBySource.delete(source);
    else this.waitingBySource.set(source, left);
  }
}

/** The process's one gate: every reply opened by the public doors and the service goes through it. */
export const mmgReplyGate = new ReplyDecryptGate();
