import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { cardRailV2DrainEnabled, cardRailV2Enabled } from '../../utils/card-rail';
import { getCardRailProvider } from '../../providers/card/card-rail-factory';
import type { CardRailSource } from '../../providers/card/card-provider';
import type { NotificationService } from '../notification/notification.service';
import type { BillingService } from './billing.service';
import { CardRailService } from './card-rail.service';

/**
 * [PT-1 · AX297 F5] What the billing worker wires for card rail v2, or
 * nothing at all.
 *
 * CARD_RAIL_V2 off (the default): a strict no-op. The worker builds no v2
 * provider and no card service and sweeps no session; billing's v2 retrieval
 * finds no provider, so a v2 intent stays UNKNOWN and is counted by the
 * unknown-card gauge rather than asked about.
 *
 * Draining what v2 left in flight after it was switched off is its own,
 * explicit decision: CARD_RAIL_V2_DRAIN=1 (default 0) wires the provider for
 * confirming open sessions and retrieving v2 charges already sent. New
 * sessions and new charges still need CARD_RAIL_V2=1: both are gated where
 * they start (CardRailService.startSession, BillingService.attemptCharge).
 */
export function cardRailWorkerSource(
  deps: { redis: Redis },
  env: Record<string, string | undefined> = process.env,
): CardRailSource | undefined {
  if (!cardRailV2Enabled(env) && !cardRailV2DrainEnabled(env)) return undefined;
  return () => getCardRailProvider(deps, env);
}

/** The card-session sweep the worker runs with every billing poll, only when
 *  a v2 provider is wired (see cardRailWorkerSource). Null when it is not. */
export async function sweepCardSessions(
  deps: { prisma: PrismaClient; notifications: NotificationService; billing: BillingService; cardRail: CardRailSource | undefined },
  now?: Date,
): Promise<Awaited<ReturnType<CardRailService['sweepSessions']>> | null> {
  if (!deps.cardRail) return null;
  return new CardRailService(deps.prisma, deps.notifications, deps.billing, deps.cardRail).sweepSessions(now);
}
