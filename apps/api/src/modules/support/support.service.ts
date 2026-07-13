import type { PrismaClient, SupportCategory, SupportStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

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

  async resolve(ticketId: string, adminId: string, input: { status: SupportStatus; adminNote?: string }) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);

    const resolving = input.status === 'RESOLVED';
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: input.status,
        adminNote: input.adminNote ?? ticket.adminNote,
        ...(resolving ? { resolvedById: adminId, resolvedAt: new Date() } : {}),
      },
    });

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
