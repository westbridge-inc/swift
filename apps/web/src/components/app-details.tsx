import Link from 'next/link';
import { site } from '@/site.config';
import packageInfo from '../../package.json';

export function AppDetails() {
  return <section aria-label="App and contact details" className="space-y-4 rounded-2xl border border-black/5 bg-white p-5">
    <h2 className="font-bold">About Swift</h2>
    <p>Order from local stores, book rides, send packages and find services with Swift.</p>
    <p className="text-sm text-[var(--swift-muted)]">Swift web app · Version {packageInfo.version}</p>
    <div className="space-y-2">
      <h3 className="font-semibold">Contact us</h3>
      <p>{site.legalEntityName}</p>
      <address className="not-italic">{site.address}</address>
      <a className="block min-h-11 py-2 text-[var(--swift-red)] underline" href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
      <a className="block min-h-11 py-2 text-[var(--swift-red)] underline" href={`tel:${site.phone.replace(/\s/g, '')}`}>{site.phone}</a>
    </div>
    <nav aria-label="App information" className="flex flex-wrap gap-4 text-[var(--swift-red)] underline">
      <Link className="py-2" href="/account/help">Get help</Link>
      <Link className="py-2" href="/faq">Frequently asked questions</Link>
      <Link className="py-2" href="/legal/terms">Terms of service</Link>
      <Link className="py-2" href="/legal/privacy">Privacy policy</Link>
    </nav>
  </section>;
}
