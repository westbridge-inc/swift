// The journey context [TASK-057]: who is signed in, what was provisioned, and
// a per-journey stash that carries state from `prepare` to `run`.

import type { Session } from '../client.js';
import type { Roster } from '../roster.js';
import type { TargetIdentity } from '../guard.js';

export interface WorldItem { itemId: string; categoryId: string; price: number; name: string }

export interface World {
  /** One orderable item per provisioned vendor (by roster id). */
  items: Record<string, WorldItem | undefined>;
  /** Roster ids of vendors that are approved, open and accepting. */
  liveVendors: string[];
  /** Roster ids of movers cleared to go online (documents approved, gates passed). */
  readyMovers: string[];
  /** Roster ids of movers currently online, with their last reported position. */
  onlineMovers: string[];
  /** Why a vendor or mover could not be made ready (roster id → reason). */
  notReady: Record<string, string>;
  /** Service provider roster id → provider profile id, when provisioned. */
  providers: Record<string, string | undefined>;
}

export interface Ctx {
  runId: string;
  log: (s: string) => void;
  identity: TargetIdentity;
  admin: Session;
  adminPhone: string;
  roster: Roster;
  world: World;
  /** Per-journey scratch: prepare → run. */
  stash: Record<string, any>;
}
