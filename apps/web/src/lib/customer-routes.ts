/**
 * [Q7b] Where every page of the customer app sits: whether a guest may open
 * it, which tab it lights up, and where its in-app back button goes when there
 * is no history to return to (an installed web app has no browser back).
 *
 * PRIVATE UNLESS NAMED. A page added under the customer shell is behind
 * sign-in until it is listed as public here — a forgotten entry costs a guest
 * one tap, never an account's data.
 *
 * The tabs match the phone app's HomeTabs (apps/mobile CustomerStack):
 * Home · Market · Cart · Profile, with Market shown only when the server's
 * launch-depth verdict says the catalogue is deep enough.
 */

export type CustomerTab = 'home' | 'market' | 'cart' | 'profile';

export interface SignInDoor {
  title: string;
  body: string;
}

export interface CustomerRoute {
  /** A guest may open it: browsing is public, like the phone app. */
  public: boolean;
  /** The tab it belongs to. */
  tab: CustomerTab;
  /** Where the back button goes with no in-app history; null on a tab's root. */
  parent: string | null;
  /** What a guest is told on a private page, above the sign-in button. */
  door: SignInDoor;
}

export const HOME_PATH = '/';

const DEFAULT_DOOR: SignInDoor = {
  title: 'Sign in to continue',
  body: 'This part of Swift belongs to your account.',
};

type RouteRule = { match: (_pathname: string) => boolean } & Omit<CustomerRoute, 'door'> & { door?: SignInDoor };

const exact = (path: string) => (pathname: string) => pathname === path;
const under = (prefix: string) => (pathname: string) => pathname.startsWith(`${prefix}/`) && pathname.length > prefix.length + 1;

const RULES: RouteRule[] = [
  { match: exact('/'), public: true, tab: 'home', parent: null },
  // The old home address; it redirects to / (old links and first installs).
  { match: exact('/order'), public: true, tab: 'home', parent: null },
  { match: exact('/order/browse'), public: true, tab: 'home', parent: HOME_PATH },
  { match: exact('/order/search'), public: true, tab: 'home', parent: HOME_PATH },
  { match: under('/order/vendor'), public: true, tab: 'home', parent: HOME_PATH },
  { match: exact('/explore'), public: true, tab: 'home', parent: HOME_PATH },
  // Taxi on the web is an explanation and an app link — booking stays off.
  { match: exact('/taxi'), public: true, tab: 'home', parent: HOME_PATH },
  { match: exact('/market'), public: true, tab: 'market', parent: null },
  {
    match: exact('/cart'), public: false, tab: 'cart', parent: HOME_PATH,
    door: { title: 'Sign in to start a cart', body: 'Your basket lives on your account, so it follows you between devices.' },
  },
  {
    match: exact('/account'), public: false, tab: 'profile', parent: null,
    door: { title: 'You’re browsing as a guest', body: 'Sign in to see your orders and your delivery addresses.' },
  },
  {
    match: exact('/orders'), public: false, tab: 'profile', parent: '/account',
    door: { title: 'Sign in to see your orders', body: 'Your orders and their live tracking are kept on your account.' },
  },
  {
    match: under('/orders'), public: false, tab: 'profile', parent: '/orders',
    door: { title: 'Sign in to track this order', body: 'Tracking opens for the account that placed the order.' },
  },
  {
    match: exact('/order/location'), public: false, tab: 'profile', parent: '/account',
    door: { title: 'Sign in to manage your addresses', body: 'Delivery addresses are saved on your account.' },
  },
  {
    match: exact('/courier'), public: false, tab: 'home', parent: HOME_PATH,
    door: { title: 'Sign in to send a package', body: 'A courier is booked from your account, so the rider knows who to call.' },
  },
];

export function customerRoute(pathname: string): CustomerRoute {
  const rule = RULES.find((candidate) => candidate.match(pathname));
  if (!rule) return { public: false, tab: 'home', parent: HOME_PATH, door: DEFAULT_DOOR };
  return { public: rule.public, tab: rule.tab, parent: rule.parent, door: rule.door ?? DEFAULT_DOOR };
}

/** The sign-in page, told to bring the person back to exactly where they were. */
export function signInPath(returnPath: string): string {
  return `/login?next=${encodeURIComponent(returnPath)}`;
}

/** The sign-up page, with the same return. */
export function signUpPath(returnPath: string): string {
  return `/signup?next=${encodeURIComponent(returnPath)}`;
}
