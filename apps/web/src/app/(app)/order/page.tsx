import { redirect } from 'next/navigation';

/**
 * [Q7b] The customer home moved to `/` — the site opens on it. This address
 * keeps working for every link, bookmark and first install (whose manifest
 * started at /order?source=pwa) that still points here.
 */
export default function LegacyOrderHome(): never {
  redirect('/');
}
