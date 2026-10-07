import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [PROD-PATH] Seed ceremony approvals signed by PEOPLE, not by a shared key.
//
// Each approver makes their own Ed25519 key on their own computer
//   ssh-keygen -t ed25519 -f ~/.ssh/swift_seed_approver -C <name>
// and hands over only the public line. The server's encrypted store holds the
// pinned list (SEED_APPROVER_KEYS: one `<name> ssh-ed25519 AAAA…` per line).
// An approval is that person's OpenSSH signature (`ssh-keygen -Y sign`, the
// documented SSHSIG format, namespace swift-seed-approval) over a request the
// server printed: what is approved (digests), for which database, which first
// admin, when it was issued and until when, with a random nonce, AND the
// words the approver reads — the database's name, the configuration and FX
// rate, the admin phone's last digits and every change — which the server
// rebuilds from the change it is about to make and requires byte for byte.
// So what an approver reads is what they sign, and what they sign is what
// runs. So:
//   - a name is never identity: the signature must verify under the key
//     pinned FOR that name, and two approvals need two different pinned keys;
//   - an approval expires (at most 72 hours after it was ISSUED, however
//     late it is used) and is single-use: its
//     consumption is recorded in the append-only privileged-change audit under
//     the same lock as the change, and a replay is refused even after the
//     database is rolled back to the approved precondition.
// No private key ever reaches the server, so the server cannot sign for anyone.
// ---------------------------------------------------------------------------

export const APPROVAL_NAMESPACE = 'swift-seed-approval';
export const APPROVAL_HEADER = 'swift-seed-approval v2';
/** The request's closing line: nothing is signed after it. */
export const APPROVAL_END = 'end';
/** A request issued a little ahead of this clock (clock skew) is still accepted. */
export const APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const APPROVAL_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const APPROVAL_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** An approver's name as it is pinned: short, lowercase, no spaces. */
export const APPROVER_NAME = /^[a-z][a-z0-9-]{1,31}$/;

export type ApprovalKind = 'plan' | 'promote';

export class ApprovalRefused extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); this.name = 'ApprovalRefused'; }
}

/** One signed approval as the operator passes it on: the approver's name, the
 *  exact request they signed (base64) and their SSHSIG signature (base64). */
export interface SignedApproval { approver: string; request: string; signature: string }

/** What a request binds: the kind, the database (target digest), the change
 *  (plan digest or promoted phone's hash), the first admin it mints (a phone
 *  hash, or `none`), and the lines the approver reads. */
export interface RequestFacts { change: ApprovalKind; target: string; subject: string; admin: string; shows: string[] }
export interface ApprovalRequest extends RequestFacts { issued: string; expires: string; nonce: string }
/** Each line an approver reads names its fact; nothing else may be signed,
 *  and no control character (one could hide a line on a terminal). */
const SHOW_LINE = /^(database|config|admin phone|change|promote): \P{Cc}+$/u;

export interface PinnedApprover { name: string; keyBlob: Buffer; fingerprint: string }

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The subject of a promotion: the phone, hashed, so no request carries it. */
export const promotionSubject = (phone: string) => `phone-sha256:${sha256hex(phone)}`;

export function canonicalRequest(r: ApprovalRequest): string {
  return [
    APPROVAL_HEADER, `kind: ${r.change}`, `target: ${r.target}`, `subject: ${r.subject}`, `admin: ${r.admin}`,
    `issued: ${r.issued}`, `expires: ${r.expires}`, `nonce: ${r.nonce}`, ...r.shows, APPROVAL_END,
  ].join('\n') + '\n';
}

/** What the server prints for the approvers to sign: issued now, valid for `lifetimeMs`. */
export function approvalRequest(facts: RequestFacts, now = new Date(), lifetimeMs = APPROVAL_DEFAULT_LIFETIME_MS): string {
  return canonicalRequest({
    ...facts, issued: now.toISOString(), expires: new Date(now.getTime() + lifetimeMs).toISOString(), nonce: randomBytes(16).toString('hex'),
  });
}

export function parseRequest(text: string): ApprovalRequest {
  const lines = text.split('\n');
  const field = (i: number, name: string) => {
    const line = lines[i] ?? '';
    if (!line.startsWith(`${name}: `)) throw new ApprovalRefused('REQUEST_MALFORMED', `the request's line ${i + 1} is not "${name}: …"`);
    return line.slice(name.length + 2);
  };
  if (lines[0] !== APPROVAL_HEADER) throw new ApprovalRefused('REQUEST_MALFORMED', 'the request does not start with the approval header');
  const change = field(1, 'kind');
  if (change !== 'plan' && change !== 'promote') throw new ApprovalRefused('REQUEST_MALFORMED', 'the request kind is neither plan nor promote');
  const end = lines.indexOf(APPROVAL_END, 8);
  if (end === -1 || lines.length !== end + 2 || lines[end + 1] !== '') throw new ApprovalRefused('REQUEST_MALFORMED', 'the request does not close with its end line');
  const r: ApprovalRequest = {
    change, target: field(2, 'target'), subject: field(3, 'subject'), admin: field(4, 'admin'),
    issued: field(5, 'issued'), expires: field(6, 'expires'), nonce: field(7, 'nonce'), shows: lines.slice(8, end),
  };
  if (!/^[0-9a-f]{32}$/.test(r.nonce) || !Number.isFinite(Date.parse(r.issued)) || !Number.isFinite(Date.parse(r.expires))) {
    throw new ApprovalRefused('REQUEST_MALFORMED', 'the request nonce, issue time or expiry is malformed');
  }
  if (!r.shows.some((l) => l.startsWith('database: ')) || !r.shows.every((l) => SHOW_LINE.test(l))) {
    throw new ApprovalRefused('REQUEST_MALFORMED', 'the request does not say, line by line, what it approves');
  }
  // Exactly the canonical bytes: nothing extra signed, nothing reinterpreted.
  if (canonicalRequest(r) !== text) throw new ApprovalRefused('REQUEST_MALFORMED', 'the request is not in canonical form');
  return r;
}

// -- SSH wire format (RFC 4251 strings) --------------------------------------
class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  bytes(n: number): Buffer {
    if (this.at + n > this.buf.length) throw new ApprovalRefused('APPROVAL_INVALID', 'the signature is truncated');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u32(): number { return this.bytes(4).readUInt32BE(0); }
  string(): Buffer { return this.bytes(this.u32()); }
  done(): boolean { return this.at === this.buf.length; }
}
const sshString = (b: Buffer | string) => {
  const body = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
};

/** The raw 32-byte Ed25519 key inside an `ssh-ed25519` public key blob. */
function ed25519FromBlob(blob: Buffer): Buffer {
  const r = new Reader(blob);
  if (r.string().toString('utf8') !== 'ssh-ed25519') throw new ApprovalRefused('KEY_UNSUPPORTED', 'only ssh-ed25519 approver keys are accepted');
  const raw = r.string();
  if (raw.length !== 32 || !r.done()) throw new ApprovalRefused('KEY_UNSUPPORTED', 'the ed25519 key is malformed');
  return raw;
}

/** Parse the pinned list: `<name> ssh-ed25519 <base64> [comment]` per line.
 *  A repeated name or a repeated key is refused: one key is one person. */
export function parseApproverKeys(text: string | undefined): Map<string, PinnedApprover> {
  const out = new Map<string, PinnedApprover>();
  const seenKeys = new Set<string>();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, type, b64] = line.split(/\s+/);
    if (!name || !APPROVER_NAME.test(name) || type !== 'ssh-ed25519' || !b64) throw new ApprovalRefused('KEYS_MALFORMED', 'SEED_APPROVER_KEYS lines are "<name> ssh-ed25519 <key>" with a short lowercase name');
    const keyBlob = Buffer.from(b64, 'base64');
    ed25519FromBlob(keyBlob);
    const fingerprint = `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
    if (out.has(name)) throw new ApprovalRefused('KEYS_MALFORMED', `SEED_APPROVER_KEYS names ${name} twice`);
    if (seenKeys.has(fingerprint)) throw new ApprovalRefused('KEYS_MALFORMED', 'SEED_APPROVER_KEYS pins one key under two names; each approver has their own key');
    seenKeys.add(fingerprint);
    out.set(name, { name, keyBlob, fingerprint });
  }
  return out;
}

/** Verify one SSHSIG signature (PROTOCOL.sshsig) over `message`; returns the
 *  public key blob that signed it. Ed25519 only. */
export function verifySshSig(signatureB64: string, message: Buffer, namespace = APPROVAL_NAMESPACE): Buffer {
  const blob = Buffer.from(signatureB64.replace(/-----[A-Z ]+-----|\s+/g, ''), 'base64');
  const r = new Reader(blob);
  if (r.bytes(6).toString('latin1') !== 'SSHSIG') throw new ApprovalRefused('APPROVAL_INVALID', 'the signature is not an SSH signature');
  if (r.u32() !== 1) throw new ApprovalRefused('APPROVAL_INVALID', 'the SSH signature version is not 1');
  const publicKey = r.string();
  const ns = r.string().toString('utf8');
  const reserved = r.string();
  const hashAlg = r.string().toString('utf8');
  const sigBlob = r.string();
  if (!r.done()) throw new ApprovalRefused('APPROVAL_INVALID', 'the signature has trailing data');
  if (ns !== namespace) throw new ApprovalRefused('APPROVAL_INVALID', 'the signature is for another purpose (namespace)');
  if (hashAlg !== 'sha512' && hashAlg !== 'sha256') throw new ApprovalRefused('APPROVAL_INVALID', 'the signature hash is not sha256 or sha512');
  const s = new Reader(sigBlob);
  if (s.string().toString('utf8') !== 'ssh-ed25519') throw new ApprovalRefused('APPROVAL_INVALID', 'the signature is not ed25519');
  const sig = s.string();
  if (sig.length !== 64 || !s.done()) throw new ApprovalRefused('APPROVAL_INVALID', 'the ed25519 signature is malformed');
  const digest = createHash(hashAlg).update(message).digest();
  const signed = Buffer.concat([Buffer.from('SSHSIG', 'latin1'), sshString(ns), sshString(reserved), sshString(hashAlg), sshString(digest)]);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: ed25519FromBlob(publicKey).toString('base64url') }, format: 'jwk' });
  if (!verifySignature(null, signed, key, sig)) throw new ApprovalRefused('APPROVAL_INVALID', 'the signature does not verify');
  return publicKey;
}

export interface VerifiedApproval { approver: string; fingerprint: string; consumption: string; admin: string; issued: string; expires: string; nonce: string }

/**
 * Two (or more) approvals by DIFFERENT pinned people over exactly this change:
 * its kind, database, subject and first admin, and the very lines the server
 * prints for it now (so an approver never signed words other than the change
 * that runs), issued no later than now and valid at most 72 hours from issue,
 * unexpired. Returns what must be consumed.
 */
export function verifyApprovals(
  approvals: SignedApproval[],
  pinned: Map<string, PinnedApprover>,
  expect: RequestFacts,
  now = new Date(),
): VerifiedApproval[] {
  if (pinned.size < 2) throw new ApprovalRefused('APPROVERS_NOT_PINNED', 'SEED_APPROVER_KEYS must pin at least two approvers, each with their own key');
  if (approvals.length < 2) throw new ApprovalRefused('APPROVALS_REQUIRED', 'this change needs two approvals by two different people');
  const out: VerifiedApproval[] = [];
  for (const a of approvals) {
    const who = pinned.get(a.approver);
    if (!who) throw new ApprovalRefused('APPROVER_UNKNOWN', `${a.approver || '?'} is not a pinned approver`);
    const requestText = Buffer.from(a.request, 'base64').toString('utf8');
    const req = parseRequest(requestText);
    if (req.change !== expect.change || req.target !== expect.target || req.subject !== expect.subject) {
      throw new ApprovalRefused('APPROVAL_INVALID', `approval by ${a.approver} is for another ${req.change === expect.change ? 'database or subject' : 'kind of change'}`);
    }
    if (req.admin !== expect.admin) throw new ApprovalRefused('APPROVAL_INVALID', `approval by ${a.approver} names another first admin`);
    // What the approver read must be what the server describes now, line for
    // line (database, configuration and FX rate, admin phone, every change).
    if (canonicalRequest({ ...req, shows: expect.shows }) !== requestText) {
      throw new ApprovalRefused('APPROVAL_INVALID', `approval by ${a.approver} was signed over another description of this change; sign the request printed now`);
    }
    const issuedAt = Date.parse(req.issued);
    const expiresAt = Date.parse(req.expires);
    if (issuedAt > now.getTime() + APPROVAL_CLOCK_SKEW_MS) throw new ApprovalRefused('APPROVAL_INVALID', `approval by ${a.approver} claims to be issued in the future (${req.issued})`);
    if (expiresAt <= now.getTime()) throw new ApprovalRefused('APPROVAL_EXPIRED', `approval by ${a.approver} expired at ${req.expires}`);
    // Measured from issue, not from use: a request is never good for more
    // than 72 hours after the server printed it, however late it is used.
    if (expiresAt - issuedAt > APPROVAL_MAX_LIFETIME_MS) throw new ApprovalRefused('APPROVAL_TOO_LONG', `approval by ${a.approver} is valid for more than 72 hours from when it was issued`);
    const signer = verifySshSig(a.signature, Buffer.from(requestText, 'utf8'));
    if (!signer.equals(who.keyBlob)) throw new ApprovalRefused('APPROVAL_INVALID', `approval by ${a.approver} is not signed with ${a.approver}'s pinned key`);
    // Single use is keyed on WHAT was approved and BY WHOM — the signer's
    // pinned key and the exact request (which carries its random nonce) —
    // never on the text the operator pasted: an armored, re-wrapped or
    // re-hashed (sha256 vs sha512) form of the same approval is the same
    // approval, and is consumed once.
    out.push({ approver: who.name, fingerprint: who.fingerprint, consumption: `approval:${sha256hex(`${who.fingerprint}\n${requestText}`)}`, admin: req.admin, issued: req.issued, expires: req.expires, nonce: req.nonce });
  }
  if (new Set(out.map((v) => v.fingerprint)).size < 2 || new Set(out.map((v) => v.approver)).size < 2) {
    throw new ApprovalRefused('APPROVERS_NOT_DISTINCT', 'the approvals must come from two different people (two different pinned keys)');
  }
  return out;
}

/**
 * Single use: inside the change's own transaction, under its advisory lock,
 * refuse any approval already consumed and record each one. The audit table
 * is append-only, so a rolled-back database still remembers.
 */
export async function consumeApprovals(
  tx: Prisma.TransactionClient,
  verified: VerifiedApproval[],
  context: { action: string; target: Prisma.InputJsonValue; actor?: string },
): Promise<void> {
  // Fail closed whatever the caller verified: a change gated on two people
  // never proceeds on fewer than two distinct consumed approvals.
  if (verified.length < 2 || new Set(verified.map((v) => v.fingerprint)).size < 2) {
    throw new ApprovalRefused('APPROVALS_REQUIRED', 'this change needs two approvals by two different people');
  }
  for (const v of verified) {
    const used = await tx.privilegedChangeAudit.findFirst({ where: { action: 'SEED_APPROVAL_CONSUMED', planDigest: v.consumption }, select: { id: true } });
    if (used) throw new ApprovalRefused('APPROVAL_REPLAYED', `approval by ${v.approver} was already used; sign a new request`);
  }
  for (const v of verified) {
    await tx.privilegedChangeAudit.create({
      data: {
        action: 'SEED_APPROVAL_CONSUMED', planDigest: v.consumption, event: 'CONSUMED', target: context.target,
        detail: { for: context.action, approver: v.approver, fingerprint: v.fingerprint, issued: v.issued, expires: v.expires, nonce: v.nonce },
        actor: context.actor ?? null,
      },
    });
  }
}

export function parseSignedApprovals(raw: string | undefined, name: string): SignedApproval[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new ApprovalRefused('APPROVALS_MALFORMED', `${name} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new ApprovalRefused('APPROVALS_MALFORMED', `${name} is not a JSON array`);
  return parsed.map((a) => {
    const o = a as Partial<SignedApproval>;
    if (typeof o.approver !== 'string' || typeof o.request !== 'string' || typeof o.signature !== 'string') {
      throw new ApprovalRefused('APPROVALS_MALFORMED', `${name}: an approval is {"approver","request","signature"} as deploy/seed-approve.sh prints it`);
    }
    return { approver: o.approver, request: o.request, signature: o.signature };
  });
}
