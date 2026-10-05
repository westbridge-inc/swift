import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { EvidenceService } from '../modules/safety/evidence.service';

describe('MASTER-070 authorized parent before evidence capture', () => {
  it.each(['case', 'sos'])('refuses a missing parent through %s before private child reads or writes', async (kind) => {
    const findMany = vi.fn().mockResolvedValue([{ content: 'foreign synthetic content' }]);
    const create = vi.fn().mockResolvedValue({ id: 'unexpected-bundle' });
    const prisma = {
      incidentCase: { findUnique: vi.fn().mockResolvedValue({ id: 'case', caseNumber: 'CASE', orderId: 'missing', subjectUserId: 'subject' }) },
      sosAlert: { findUnique: vi.fn().mockResolvedValue({ id: 'sos', orderId: 'missing', counterpartyUserId: 'subject' }) },
      evidenceBundle: { findUnique: vi.fn().mockResolvedValue(null), create },
      order: { findUnique: vi.fn().mockResolvedValue(null) },
      orderStatusLog: { findMany },
      tripSafetySession: { findUnique: vi.fn().mockResolvedValue(null) },
      chatRoom: { findFirst: vi.fn().mockResolvedValue({ id: 'foreign-room' }) },
      chatMessage: { findMany },
      livenessCheck: { findMany },
    };
    const service = new EvidenceService(prisma as unknown as PrismaClient, {} as Server);
    const capture = kind === 'case' ? service.openForCase('case') : service.openForSos('sos');
    await expect(capture).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(findMany).not.toHaveBeenCalled();
    expect(prisma.tripSafetySession.findUnique).not.toHaveBeenCalled();
    expect(prisma.chatRoom.findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
