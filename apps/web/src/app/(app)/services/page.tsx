import { servicesSeed } from '@/lib/browse-server';
import { ServicesScreen } from './services-screen';

/**
 * [W11] Local pros — the phone app's Services screen on the web. The server
 * reads the public catalogue and, for a trade the catalogue lists as taking
 * requests, its first providers, as a GUEST (lib/browse-server.ts), so the page
 * arrives with them in it. Asking for a quote needs an account.
 */
export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams)['trade'];
  return <ServicesScreen seed={await servicesSeed(typeof requested === 'string' ? requested : '')} />;
}
