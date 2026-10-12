// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] EVERY SERVER ANSWER, IN PLAIN WORDS, WITH THE NEXT STEP.
//
// `apiFetch` already throws an Error carrying the server's `code`, `status`
// and `details`. The pages threw that away: an approve refused with 409
// CHECKLIST_INCOMPLETE rendered nothing ("it silently didn't work"), and a
// money action queued with 202 APPROVAL_REQUIRED rendered as nothing or as a
// failure — so the operator retried and filed a second approval.
//
// This module turns any answer into an `Outcome`: one sentence saying what
// happened, the next step, a link to where it can be done, and — in small
// print, for support, never alone — the server's code and HTTP status.
// `<ActionResult>` renders it; `<QueryFailed>` uses it for reads.
//
// It generalises lib/cashRail `outcomeOfThrown` (the three pages that already
// read a 202 correctly) to every code the console meets.
// ---------------------------------------------------------------------------

import { errorCode, errorDetails, errorStatus } from './api';

export type OutcomeTone = 'success' | 'queued' | 'refused' | 'failed';

export interface OutcomeLink {
  label: string;
  href: string;
}

export interface Outcome {
  tone: OutcomeTone;
  /** What happened, in one plain sentence. */
  title: string;
  /** What to do next, in plain words. */
  next?: string;
  /** Where to do it. */
  link?: OutcomeLink;
  /** The server's own sentence, kept when it carries specifics (which store, how many minutes). */
  serverMessage?: string;
  /** For support, shown small beside the words — never on its own. */
  code?: string;
  status?: number;
  /** The queued approval, when the server named it. */
  approvalId?: string;
  /** True when nobody can know whether a write happened (timeouts, dropped connections, 5xx). */
  uncertain?: boolean;
}

export interface OutcomeContext {
  /** The person whose documents gate this action (a store's owner, a mover). Deep-links the Review Center. */
  applicantId?: string;
  /** A read or a write: "nothing was changed" is only ever promised where it is true. */
  kind?: 'read' | 'write';
}

export const APPROVALS_HREF = '/approvals';

/** The Review Center, opened on one applicant when we know who. */
export function reviewCenterHref(applicantId?: string): string {
  return applicantId ? `/verification?applicant=${encodeURIComponent(applicantId)}` : '/verification';
}

/** A success, in the words the page chose ("Target Store is live."). */
export function succeeded(title: string, next?: string): Outcome {
  return next ? { tone: 'success', title, next } : { tone: 'success', title };
}

type Copy = Pick<Outcome, 'tone' | 'title' | 'next' | 'link' | 'uncertain'>;

const NOTHING_CHANGED = 'Nothing was changed.';

/** Answers known by their code. The server's sentence is kept beneath these. */
function byCode(code: string, ctx: OutcomeContext): Copy | null {
  switch (code) {
    case 'APPROVAL_REQUIRED':
      return {
        tone: 'queued',
        title: "Sent for a second admin's approval",
        next: 'Nothing has changed yet. A different admin must approve it in Approvals; once they do, you apply it from there. Do not send it again — that would ask twice.',
        link: { label: 'Open Approvals', href: APPROVALS_HREF },
      };
    case 'CHECKLIST_INCOMPLETE':
      return {
        tone: 'refused',
        title: 'Approve the required documents in Verification first',
        next: `${NOTHING_CHANGED} Open the owner's documents in the Review Center and decide each one that is still waiting.`,
        link: { label: 'Open in Review Center', href: reviewCenterHref(ctx.applicantId) },
      };
    case 'VENDOR_TIER_NO_PROMOTION':
      return {
        tone: 'refused',
        title: "This store can't be featured yet",
        next: `${NOTHING_CHANGED} Featuring opens once a business registration is approved for the owner.`,
        link: { label: 'Open in Review Center', href: reviewCenterHref(ctx.applicantId) },
      };
    case 'ALREADY_ACTIVE':
      return { tone: 'refused', title: 'This store is already live', next: 'Nothing more is needed. Refresh to see its current status.' };
    case 'STEP_UP_REQUIRED':
      return {
        tone: 'refused',
        title: "Confirm it's you first",
        next: `${NOTHING_CHANGED} This action needs a one-time code sent to the phone on your admin account. Confirm with the code, then try again.`,
      };
    case 'STEP_UP_LOCKED':
      return { tone: 'refused', title: 'Too many wrong codes', next: `${NOTHING_CHANGED} Wait, then try again.` };
    case 'REASON_UNSENDABLE':
      return {
        tone: 'refused',
        title: "The reason has characters that can't be sent",
        next: `${NOTHING_CHANGED} Use letters, numbers and ordinary punctuation (no emoji), then try again.`,
      };
    case 'SESSION_EXPIRED':
    case 'UNAUTHORIZED':
    case 'INVALID_TOKEN':
      return { tone: 'refused', title: 'Your session has ended', next: 'Sign in again, then try once more.', link: { label: 'Sign in', href: '/login' } };
    case 'NETWORK_ERROR':
      return {
        tone: 'failed',
        title: "Couldn't reach Swift's server",
        uncertain: ctx.kind !== 'read',
        next: ctx.kind === 'read'
          ? 'Check your connection, then retry.'
          : 'Check your connection. If it dropped while sending, refresh and check whether it went through before you try again.',
      };
    case 'TIMEOUT':
      return timeout(ctx);
    default:
      return null;
  }
}

function timeout(ctx: OutcomeContext): Copy {
  return {
    tone: 'failed',
    title: "Swift's server didn't answer in time",
    uncertain: ctx.kind !== 'read',
    next: ctx.kind === 'read'
      ? 'Retry in a moment.'
      : 'It may or may not have gone through. Refresh the page and check before you try again.',
  };
}

/** Answers known only by their HTTP status. */
function byStatus(status: number | undefined, ctx: OutcomeContext): Copy {
  const read = ctx.kind === 'read';
  switch (status) {
    case 400:
    case 422:
      return { tone: 'refused', title: "Swift couldn't accept that", next: `${NOTHING_CHANGED} Fix what the message says, then try again.` };
    case 401:
      return byCode('SESSION_EXPIRED', ctx)!;
    case 403:
      return {
        tone: 'refused',
        title: read ? "You don't have permission to see this" : "You don't have permission to do this",
        next: `${read ? '' : `${NOTHING_CHANGED} `}If you think you should, ask a super admin to check your access.`,
      };
    case 404:
      return {
        tone: 'refused',
        title: "This record doesn't exist, or isn't in your market",
        next: `${read ? '' : `${NOTHING_CHANGED} `}Go back to the list and refresh.`,
      };
    case 409:
      return {
        tone: 'refused',
        title: "This clashes with the record's current state",
        next: `${NOTHING_CHANGED} Refresh to see the latest, then decide again.`,
      };
    case 429:
      return { tone: 'refused', title: 'Too many tries in a short time', next: `${read ? '' : `${NOTHING_CHANGED} `}Wait a minute, then try again.` };
    case 502:
    case 504:
      return timeout(ctx);
    case 503:
      return {
        tone: 'failed',
        title: "Swift can't do this right now",
        next: `A service it needs is not available. ${read ? '' : `${NOTHING_CHANGED} `}Try again in a few minutes; if it keeps happening, tell the tech team.`,
      };
    default:
      if (status !== undefined && status >= 500) {
        return {
          tone: 'failed',
          title: "Something went wrong on Swift's server",
          uncertain: !read,
          next: read
            ? 'Retry in a moment; if it keeps happening, tell the tech team.'
            : 'Refresh and check whether it went through before you try again. If it keeps happening, tell the tech team.',
        };
      }
      return {
        tone: 'failed',
        title: 'Something went wrong',
        uncertain: !read,
        next: read ? 'Retry in a moment.' : 'Refresh and check whether it went through before you try again.',
      };
  }
}

const NETWORK_MESSAGES = /failed to fetch|networkerror|network request failed|load failed|fetch failed|the internet connection appears to be offline/i;

/** What the browser threw before any answer arrived, as a client-side code. */
function clientCode(error: unknown): 'NETWORK_ERROR' | 'TIMEOUT' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
  if (name === 'TypeError' && typeof message === 'string' && NETWORK_MESSAGES.test(message)) return 'NETWORK_ERROR';
  return undefined;
}

/** The server's sentence, unless it is the transport's own placeholder. */
function serverSentence(error: unknown): string | undefined {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  if (/^API error: \d+$/.test(message)) return undefined; // apiFetch's fallback: no sentence was sent
  return message.trim();
}

/** The first field message of a validation refusal, when the server sent one. */
function fieldSentence(details: Record<string, unknown> | undefined): string | undefined {
  if (!details) return undefined;
  for (const value of Object.values(details)) {
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

/**
 * Any thrown answer — a server refusal, a 202 queue, a timeout, a dropped
 * connection — as plain words with the next step.
 */
export function outcomeOf(error: unknown, ctx: OutcomeContext = {}): Outcome {
  const local = clientCode(error);
  if (local) {
    const copy = byCode(local, ctx)!;
    return { ...copy, code: local };
  }

  const status = errorStatus(error);
  const code = errorCode(error);
  const details = errorDetails(error);

  // 202 is the only success-class status that arrives as a throw, and only an
  // APPROVAL_REQUIRED body makes it a queue. Anything else at 202 is not
  // dressed up as one.
  const copy = (status === 202 && code !== 'APPROVAL_REQUIRED') ? byStatus(undefined, ctx)
    : (code && (code !== 'APPROVAL_REQUIRED' || status === 202) ? byCode(code, ctx) : null) ?? byStatus(status, ctx);

  let serverMessage = local ? undefined : serverSentence(error);
  if (serverMessage === 'Invalid request data') serverMessage = fieldSentence(details) ?? serverMessage;
  const approvalId = copy.tone === 'queued' && typeof details?.['approvalId'] === 'string' ? details['approvalId'] as string : undefined;

  const outcome: Outcome = { ...copy };
  if (serverMessage && serverMessage !== copy.title) outcome.serverMessage = serverMessage;
  if (code) outcome.code = code;
  if (status !== undefined) outcome.status = status;
  if (approvalId) outcome.approvalId = approvalId;
  if (!outcome.uncertain) delete outcome.uncertain;
  return outcome;
}
