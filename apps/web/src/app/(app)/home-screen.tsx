import { CustomerHome } from '@/components/customer-home';
import { SiteFooter } from '@/components/site';
import { launch } from '@/site.config';
import type { GuestRead } from '@/lib/browse-keys';
import type { HomeFeed } from '@/lib/customer';

/** Home's whole screen: the customer app's Home, then the site footer.
 *  `seed` is the guest feed the server drew into the page, when it could. */
export function HomeScreen({ seed = null }: { seed?: GuestRead<HomeFeed> | null }) {
  return (
    <>
      <CustomerHome market={launch.markets[0]} seed={seed} />
      <div className="-mx-6 mt-12 overflow-hidden wide:-mx-10">
        <SiteFooter />
      </div>
    </>
  );
}
