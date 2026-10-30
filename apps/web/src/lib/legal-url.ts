// The legal texts' address, on its own: client code (the legal-acceptance gate in every console layout, signup, the
// VAT card, the portal) imports only this, never lib/api — lib/api is the server-side fetchers, and its React
// `cache(...)` storefront read is a top-level call no bundler can drop, so importing LEGAL_URL from there put that
// fetcher in every dashboard and portal page's first-load JavaScript.
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';

// Same origin rule as lib/api: a server-side override, else the one browser authority.
const API_URL = process.env['API_URL'] ?? BROWSER_API_ORIGIN;

export const LEGAL_URL = (doc: 'terms' | 'privacy' | 'vendor-agreement' | 'driver-agreement') => `${API_URL}/legal/${doc}`;
