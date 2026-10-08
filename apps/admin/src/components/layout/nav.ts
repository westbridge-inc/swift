import {
  Activity, FileCheck2, Stamp, Flag, LifeBuoy, PackageOpen, ShieldAlert,
  Users, Store, Bike, Car, ShoppingCart,
  RefreshCw, DollarSign, Receipt, Banknote, Tag,
  Radar, Headphones, Scale, ListRestart, Megaphone,
  FileText, Globe, Map, Settings, Compass, Fingerprint, Megaphone as AdsIcon,
  type LucideIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · shell] The sidebar, in the owner's design groups:
// Briefing · Queues · Records · Money · Operations · System.
//
// Every item opens a screen that exists today — a dead link is worse than a
// missing one. Screens the design draws that are not built yet (Triage sweep,
// Expiries, Vehicles, Staff & roles) are not listed until they are. Labels say
// what the operator is doing ("Documents", "Businesses"), not the table name.
// No counts yet: a number beside an item must come from the server (the
// briefing aggregate, a later PR), never a guess.
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** One line for the header under the page title. */
  blurb: string;
  /** Extra words the ⌘K "Go to" search matches. */
  keywords?: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Briefing',
    items: [
      { label: 'Today', href: '/dashboard', icon: Activity, blurb: 'Everything that needs you, in one place', keywords: 'dashboard overview home' },
    ],
  },
  {
    title: 'Queues',
    items: [
      { label: 'Documents', href: '/verification', icon: FileCheck2, blurb: 'Review each document and decide it', keywords: 'verification review center kyc id licence' },
      // [ADM-005] A pending row means a colleague asked for something and it has not happened yet.
      { label: 'Approvals', href: '/approvals', icon: Stamp, blurb: 'Money and platform actions waiting for a second admin', keywords: 'second signature two person' },
      { label: 'Moderation', href: '/moderation', icon: Flag, blurb: 'Reports about reviews, messages, people and stores', keywords: 'reports abuse' },
      { label: 'Custody cases', href: '/custody', icon: LifeBuoy, blurb: 'Goods a rider is holding that must be returned or handed over', keywords: 'recovery relay return' },
      { label: 'Returns', href: '/returns', icon: PackageOpen, blurb: 'Customer returns and refunds owed', keywords: 'refund' },
      { label: 'Claims', href: '/claims', icon: ShieldAlert, blurb: 'Reimbursement claims to decide and pay', keywords: 'guarantee reimbursement' },
    ],
  },
  {
    title: 'Records',
    items: [
      { label: 'People', href: '/users', icon: Users, blurb: 'Every account: customers, partners and staff', keywords: 'users customers accounts' },
      { label: 'Businesses', href: '/vendors', icon: Store, blurb: 'Stores and service businesses', keywords: 'vendors stores restaurants shops' },
      { label: 'Riders', href: '/riders', icon: Bike, blurb: 'Delivery and courier riders', keywords: 'movers delivery courier' },
      { label: 'Drivers', href: '/drivers', icon: Car, blurb: 'Taxi drivers', keywords: 'movers taxi' },
      { label: 'Orders', href: '/orders', icon: ShoppingCart, blurb: 'Every order, ride and delivery', keywords: 'trips rides deliveries' },
    ],
  },
  {
    title: 'Money',
    items: [
      { label: 'Subscribers', href: '/subscriptions', icon: RefreshCw, blurb: 'Partners on the weekly fee', keywords: 'subscriptions weekly fee billing' },
      { label: 'Revenue', href: '/finance', icon: DollarSign, blurb: "What Swift is owed and paid — never the partners' money", keywords: 'finance settlements ledger' },
      { label: 'MMG payments', href: '/mmg-payments', icon: Receipt, blurb: 'Find a weekly-fee payment by any reference', keywords: 'checkout mobile money' },
      { label: 'Received agent cash', href: '/cash', icon: Banknote, blurb: 'Attach or refund cash already received', keywords: 'agent san collections' },
      { label: 'Promos', href: '/promos', icon: Tag, blurb: 'Discount codes', keywords: 'discounts codes' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Live Ops', href: '/ops', icon: Radar, blurb: 'Movers and orders on the road now', keywords: 'live map dispatch' },
      { label: 'Support', href: '/support', icon: Headphones, blurb: 'Help tickets from customers and partners', keywords: 'tickets help' },
      { label: 'Compliance', href: '/compliance', icon: Scale, blurb: 'Movers taken offline for lapsed documents or cover', keywords: 'liability insurance' },
      { label: 'Background jobs', href: '/jobs', icon: ListRestart, blurb: 'Jobs that failed and can be retried', keywords: 'queues dlq workers' },
      { label: 'Broadcast', href: '/broadcast', icon: Megaphone, blurb: 'Send one message to everyone', keywords: 'announcement notification' },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Audit log', href: '/audit', icon: FileText, blurb: 'Who did what, and why', keywords: 'history trail' },
      { label: 'Markets', href: '/markets', icon: Globe, blurb: 'Countries Swift runs in', keywords: 'countries' },
      { label: 'Zones', href: '/zones', icon: Map, blurb: 'Delivery zones and fares', keywords: 'fares areas' },
      { label: 'Config', href: '/config', icon: Settings, blurb: 'Platform settings', keywords: 'settings' },
      { label: 'Discovery', href: '/discovery', icon: Compass, blurb: 'Categories customers browse by', keywords: 'categories tags' },
      { label: 'Integrity', href: '/integrity', icon: Fingerprint, blurb: 'Signals that two accounts are one person', keywords: 'fraud identity trial' },
      { label: 'Ads review', href: '/ads', icon: AdsIcon, blurb: 'Advertisers and creatives (ads are off at launch)', keywords: 'advertising' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** The section a path belongs to (the longest matching href). */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    if ((pathname === item.href || pathname.startsWith(`${item.href}/`)) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}
