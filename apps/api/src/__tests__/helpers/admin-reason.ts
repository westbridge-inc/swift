import { ADMIN_ACTION_CLASSES, ADMIN_ROUTE_AUTHORITY } from '../../modules/admin/admin-authority';

/**
 * [ADM-006] A consequential, money or platform admin action must state why.
 *
 * That law is graded by `admin-reason.test.ts`. Every OTHER suite is testing
 * what its route does, not that the reason rule exists, so those suites say
 * why the way a real caller does — the console prompts its operator; this
 * helper answers for the suite — and the route under test still runs.
 *
 * It reads the SAME authority table the server enforces from, so a route that
 * changes class changes here too, and a suite cannot drift into supplying a
 * reason for something that no longer needs one (or missing one that does).
 */
export const TEST_ADMIN_REASON = 'Exercised by the automated suite for this route';

const TEMPLATES: { re: RegExp; cls: keyof typeof ADMIN_ACTION_CLASSES }[] = Object.entries(ADMIN_ROUTE_AUTHORITY)
  .map(([key, authority]) => {
    const [method, template] = key.split(' ') as [string, string];
    const pattern = template.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return { re: new RegExp(`^${method}\\s(?:/api/v1/admin)?${pattern}(?:\\?.*)?$`), cls: authority.cls };
  });

/** Does this concrete request hit a route that now owes a reason? */
export function adminRouteNeedsReason(method: string, url: string): boolean {
  const subject = `${method.toUpperCase()} ${url.split('#')[0]}`;
  const match = TEMPLATES.find((t) => t.re.test(subject));
  return !!match && ADMIN_ACTION_CLASSES[match.cls].requiresReason;
}

/**
 * The payload a suite should send: its own, plus the reason the route requires
 * if the suite did not state one itself. A suite that DOES state one keeps it —
 * several assert on the reason they sent.
 */
export function withAdminReason<T>(method: string, url: string, payload?: T): T | (T & { reason: string }) | { reason: string } | undefined {
  if (!adminRouteNeedsReason(method, url)) return payload;
  if (payload && typeof payload === 'object' && 'reason' in (payload as Record<string, unknown>)) return payload;
  return { ...(payload as object ?? {}), reason: TEST_ADMIN_REASON } as T & { reason: string };
}
