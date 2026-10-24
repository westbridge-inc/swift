import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import { openOpsAlert, type OpsAlertOpened } from '../safety/ops-alert';

/**
 * [Brief item 3 · Child Safety Standards: "Reports reach our moderation team immediately and are prioritised"]
 * A report with the reason Child safety (CSAE) pages operations at once, through the same durable outbox an
 * SOS uses (an OpsAlert row with an acknowledgement deadline; a page nobody acknowledges escalates on the
 * sweep and texts the on-call list). The page names the report, never the people or the content: the text
 * goes to phones. The store-review fiction pages nobody (openOpsAlert's review-tenant rule, GUARDRAILS §3).
 */
/** One page per reporter per window: every report is recorded, but one person cannot page on-call at will. */
export const CSAE_PAGE_WINDOW_SECONDS = 600;
export const CSAE_PAGE_TITLE = 'Child-safety (CSAE) report: review now';
export const CSAE_PAGE_BODY = 'Someone reported content as child sexual abuse or exploitation. Open the moderation queue (reason: Child safety) and act on it before anything else.';

export async function pageCsaeReport(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: { tenantId: string | null; contentReportId: string; targetType: string },
): Promise<OpsAlertOpened> {
  return openOpsAlert(prisma, notifications, {
    kind: 'PLATFORM',
    tenantId: input.tenantId,
    title: CSAE_PAGE_TITLE,
    body: CSAE_PAGE_BODY,
    data: { kind: 'csae_report', contentReportId: input.contentReportId, targetType: input.targetType },
  });
}
