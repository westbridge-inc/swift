import type { PrismaClient, SupportCategory, SupportStatus, SupportResolution } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { supportResolutionCounter } from '../../plugins/observability';

/** [A-18] What a SAFETY ticket may close on. "Answered" is not one of them. */
export const SAFETY_RESOLUTIONS: SupportResolution[] = ['ACTION_TAKEN', 'ESCALATED_SAFETY', 'NO_RISK_FOUND'];
/** [A-18] The reporter reads this. A shrug is not a response to a safety report. */
export const SAFETY_NOTE_MIN = 20;

// ---------------------------------------------------------------------------
// In-app support / dispute channel. Any signed-in user (customer, mover,
// vendor) can open a ticket, optionally tied to an order they're on; every
// open ticket pings the admins (there is otherwise no signal), the owner sees
// their tickets + status, and an admin resolves it with a note that notifies
// the owner. This is the report → acknowledge → resolve loop launch needs;
// threaded replies can come later.
// ---------------------------------------------------------------------------

export interface CreateTicketInput {
  category: SupportCategory;
  subject: string;
  message: string;
  orderId?: string;
}

export class SupportService {
  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
  ) {}

  async createTicket(userId: string, input: CreateTicketInput) {
    // If it references an order, the opener must actually be on that order —
    // no fishing for other people's orders by id.
    if (input.orderId) {
      const order = await this.prisma.order.findFirst({
        where: {
          id: input.orderId,
          OR: [
            { customerId: userId },
            { rider: { userId } },
            { driver: { userId } },
            { vendor: { owner: { userId } } },
          ],
        },
        select: { id: true },
      });
      if (!order) throw new AppError(403, 'NOT_YOUR_ORDER', 'You can only raise a ticket about your own order');
    }

    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        orderId: input.orderId ?? null,
        category: input.category,
        subject: input.subject,
        message: input.message,
      },
    });

    log().warn({ ticketId: ticket.id, userId, category: input.category, orderId: input.orderId }, 'support: ticket opened');
    await notifyAdmins(this.prisma, this.notifications, {
      // The ticket belongs to the person who opened it [NOC-A F45].
      tenantId: await tenantOfUser(this.prisma, userId),
      title: 'New support ticket',
      body: `${input.category.replace(/_/g, ' ').toLowerCase()}: ${input.subject}`,
      data: { kind: 'support_ticket', ticketId: ticket.id, orderId: input.orderId },
    });

    return ticket;
  }

  async listForUser(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, category: true, subject: true, message: true, status: true, adminNote: true, orderId: true, createdAt: true, resolvedAt: true },
    });
  }

  async listForAdmin(opts: { status?: SupportStatus; page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, opts.limit ?? 20);
    const where = opts.status ? { status: opts.status } : {};
    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { tickets, total, page, limit };
  }

  /** CONTRACT [WR-022]: `adminNote` is CUSTOMER-FACING — it is stored on the
   *  ticket AND sent verbatim as the notification body. There is no internal-
   *  note field on this rail; consoles must label the input accordingly.
   *  (A true internal-notes feature is a registered follow-on.)
   *
   *  [A-18] Closing a ticket is a decision, so it carries one. A resolve must
   *  name a DISPOSITION, must say what state it believes the ticket is in, and
   *  on a SAFETY ticket must be more than "answered" and must carry a note the
   *  reporter can read. The console used to resolve on a cancelled prompt with
   *  no note at all: an urgent report left the queue with no record of anyone
   *  having looked at it. */
  async resolve(
    ticketId: string,
    adminId: string,
    input: { status: SupportStatus; adminNote?: string; resolution?: SupportResolution; expectedStatus?: SupportStatus },
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);

    const resolving = input.status === 'RESOLVED';

    // [A-18] The screen says what it was looking at. A ticket someone else
    // already moved is not re-decided from a stale view.
    if (input.expectedStatus && input.expectedStatus !== ticket.status) {
      throw new AppError(
        409,
        'TICKET_MOVED',
        `This ticket is now ${ticket.status.toLowerCase().replace('_', ' ')} — reload before deciding.`,
      );
    }
    if (resolving && ticket.status === 'RESOLVED') {
      throw new AppError(409, 'ALREADY_RESOLVED', 'This ticket is already resolved.');
    }

    if (resolving) {
      if (!input.resolution) {
        throw new AppError(400, 'RESOLUTION_REQUIRED', 'Say what happened: a resolution is required to close a ticket.');
      }
      if (ticket.category === 'SAFETY') {
        if (!SAFETY_RESOLUTIONS.includes(input.resolution)) {
          throw new AppError(
            400,
            'SAFETY_RESOLUTION_REQUIRED',
            'A safety report closes on what was DONE — action taken, escalated to the safety team, or no risk found after review.',
          );
        }
        const note = (input.adminNote ?? '').trim();
        if (note.length < SAFETY_NOTE_MIN) {
          throw new AppError(
            400,
            'SAFETY_NOTE_REQUIRED',
            `Tell the reporter what happened, in a sentence (at least ${SAFETY_NOTE_MIN} characters). They see this.`,
          );
        }
      }
    }

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: input.status,
        adminNote: input.adminNote ?? ticket.adminNote,
        ...(resolving ? { resolvedById: adminId, resolvedAt: new Date(), resolution: input.resolution } : {}),
      },
    });
    if (resolving) {
      supportResolutionCounter.labels(ticket.category, input.resolution ?? 'UNSET').inc();
    }

    // Tell the owner what happened.
    await this.notifications.send({
      userId: ticket.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: resolving ? 'Your support ticket was resolved' : 'Update on your support ticket',
      body: input.adminNote || (resolving ? 'We’ve resolved your issue. Reopen a ticket if you need more help.' : 'Our team is looking into your ticket.'),
      data: { kind: 'support_update', ticketId },
    });

    return updated;
  }
}
